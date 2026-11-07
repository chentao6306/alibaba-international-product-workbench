import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const fsp = fs.promises;
import { verifyArtifact, compareVersions } from '../auth-server/update-protocol.js';
async function hashFile(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
class Updater {
 constructor({directory,version,config,fetchImpl=fetch,onChange=()=>{},allowLocalTests=false}){
  this.directory=directory;this.version=version;this.config=config;this.fetch=fetchImpl;this.onChange=onChange;this.base=new URL(config.server);
  if(this.base.protocol!=='https:'&&!(allowLocalTests&&this.base.hostname==='127.0.0.1'))throw Error('更新服务器必须使用 HTTPS');
  fs.mkdirSync(directory,{recursive:true});this.data={status:'idle',currentVersion:version,release:null,progress:0,downloaded:0,total:0,error:'',checkedAt:null,scheduled:false};
  this.controller=null;this.checking=null;this.busy=false;this.closed=false;
  try {
    const result=fs.readFileSync(path.join(directory,'install-result.txt'),'utf8').replace(/^\uFEFF/,'').split('\n');
    this.data.installationMessage=result[1]==='0' ? `上次已安装 ${result[0]}` : `上次安装未完成：${result[2] || '请重新运行安装包修复'}。安装包和恢复副本已保留。`;
  } catch {}

  try{const release=JSON.parse(fs.readFileSync(path.join(directory,'release.json'),'utf8'));this.validate(release);if(compareVersions(release.artifact.version,version)>0)this.data.release=release;}catch{}
  // Only our named cached packages are removed after an upgrade; customer data is elsewhere.
  for(const name of fs.readdirSync(directory))if(/^[a-f0-9]{64}\.exe(?:\.part)?$/.test(name)&&!name.startsWith(this.data.release?.artifact.sha256||'none')){try{fs.unlinkSync(path.join(directory,name));}catch{}}
 }
 state(){return {...this.data,release:this.data.release?{version:this.data.release.artifact.version,title:this.data.release.title,notes:this.data.release.notes,publishedAt:this.data.release.publishedAt,size:this.data.release.artifact.size}:null};}
 set(p){Object.assign(this.data,p);if(!this.closed)this.onChange(this.state());}
 validate(release){
  if(!release||typeof release.title!=='string'||!release.title.trim()||release.title.length>100||typeof release.notes!=='string'||release.notes.length>10000||!/^\/updates\/chaodekuai\/files\/[a-f0-9-]{36}\.exe$/.test(release.url))throw Error('更新信息格式无效');
  release.artifact=verifyArtifact(release.envelope,this.config.publicKey);if(release.artifact.version.includes('-'))throw Error('正式版更新不接受测试安装包');return release;
 }
 url(route){const url=new URL(route,this.base);if(url.origin!==this.base.origin)throw Error('更新下载地址不受信任');return url.href;}
 async latest(){
  const res=await this.fetch(this.url('/updates/chaodekuai/latest.json'),{redirect:'error',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(20000), ...(this.controller ? [this.controller.signal] : [])])});
  if(!res.ok)throw Error('更新服务器暂时不可用，请稍后重试');
  let size=0,parts=[];for await(const part of res.body){size+=part.length;if(size>64000)throw Error('更新信息过大');parts.push(Buffer.from(part));}
  const data=JSON.parse(Buffer.concat(parts).toString());return data.release?this.validate(data.release):null;
 }
 async check(){
  if(this.busy||this.data.status==='installing')return this.state();if(this.checking)return this.checking;
  this.checking=(async()=>{const previous=this.data.status;this.set({status:'checking',error:''});try{
   const release=await this.latest();if(!release||compareVersions(release.artifact.version,this.version)<=0){this.set({status:'current',release:null,scheduled:false,checkedAt:Date.now(),progress:0});return this.state();}
   // A previously downloaded file is only usable after its bytes are verified again.
   const file=this.file(release),ready=await this.matches(file,release.artifact);
   const manifest=path.join(this.directory,'release.json'),temporary=manifest+'.tmp';
   const fd=fs.openSync(temporary,'w');try{fs.writeFileSync(fd,JSON.stringify(release));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,manifest);
   this.set({release,status:ready?'ready':'available',progress:ready?100:0,checkedAt:Date.now(),error:''});return this.state();
  }catch(e){this.set({status:previous==='ready'?'ready':'error',error:this.message(e)});return this.state();}finally{this.checking=null;}})();return this.checking;
 }
 message(e){if(e?.name==='TimeoutError')return '检查或下载更新超时，请检查网络后重试';if(e?.message==='fetch failed')return '无法连接更新服务器，请检查网络后重试';return String(e?.message||e);}
 file(release=this.data.release){return path.join(this.directory,release.artifact.sha256+'.exe');}
 async matches(file,a){try{return (await fsp.stat(file)).size===a.size&&await hashFile(file)===a.sha256;}catch{return false;}}
 async download(){
  if(this.busy || this.data.status === 'installing')return this.state();if(this.checking)await this.checking; if(this.busy) return this.state();
  const release=this.data.release;if(!release)throw Error('请先检查新版本');this.busy=true;this.controller=new AbortController();const signal=this.controller.signal,a=release.artifact,file=this.file(release),partial=file+'.part';
  this.set({status:'downloading',error:'',scheduled:false,total:a.size,downloaded:0,progress:0});let fd;
  try{
   const latest=await this.latest();if(!latest||latest.artifact.sha256!==a.sha256)throw Error('此版本已停止分发或有更新版本，请重新检查更新');
   if(signal.aborted)throw signal.reason;
   if(await this.matches(file,a)){this.set({status:'ready',progress:100,downloaded:a.size});return this.state();}
   let start=0;try{start=(await fsp.stat(partial)).size;}catch{}
   if(start>=a.size){if(start===a.size&&await this.matches(partial,a)){await fsp.rename(partial,file);this.set({status:'ready',progress:100,downloaded:a.size});return this.state();}await fsp.unlink(partial);start=0;}
   const stat=await fsp.statfs(this.directory);if(stat.bavail*stat.bsize<a.size-start+100*1024*1024)throw Error('更新下载目录空间不足，请清理磁盘后重试');
   const res=await this.fetch(this.url(release.url),{redirect:'error',headers:start?{Range:`bytes=${start}-`}:{},signal:AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)])});
   if(res.status===200)start=0;else if(res.status===206){if(res.headers.get('content-range')!==`bytes ${start}-${a.size-1}/${a.size}`)throw Error('续传响应校验失败，请重新下载');}else throw Error('下载失败，请检查网络或重新检查更新');
   if(Number(res.headers.get('content-length'))!==a.size-start)throw Error('下载文件大小不正确');
   this.set({downloaded:start,progress:Math.floor(start/a.size*100)});fd=await fsp.open(partial,start?'a':'w');let received=start,last=0;const reader=res.body.getReader();
   try{while(true){let timer;let next;try{next=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>{this.controller?.abort();reject(Error('下载连接中断，已保留进度，请重试继续下载'));},45000);})]);}finally{clearTimeout(timer);}if(next.done)break;if(signal.aborted)throw signal.reason;received+=next.value.length;if(received>a.size)throw Error('下载文件大小超过预期');await fd.writeFile(Buffer.from(next.value));if(Date.now()-last>250){last=Date.now();this.set({downloaded:received,progress:Math.floor(received/a.size*100)});}}}finally{await reader.cancel().catch(()=>{});}
   await fd.sync();await fd.close();fd=null;if(signal.aborted)throw signal.reason;
   if(!await this.matches(partial,a)){await fsp.unlink(partial).catch(()=>{});throw Error('安装包完整性校验失败，请重新下载');}
   await fsp.rename(partial,file);this.set({status:'ready',progress:100,downloaded:a.size,error:''});return this.state();
  }catch(e){const cancelled=signal.aborted;this.set({status:cancelled?'available':'error',error:cancelled?'下载已暂停，点击下载可继续':this.message(e)});return this.state();}
  finally{if(fd)await fd.close().catch(()=>{});this.busy=false;this.controller=null;}
 }
 cancel(){this.controller?.abort();this.set({scheduled:false});}
 schedule(value){if(value&&this.data.status!=='ready')throw Error('请先下载更新');this.set({scheduled:!!value});}
 async prepare(){
  if(this.checking)await this.checking;
  if(this.busy||this.data.status!=='ready'||!this.data.release)throw Error('请先下载并校验新版本');
  const release=this.data.release;const latest=await this.latest();
  if(!latest||latest.artifact.sha256!==release.artifact.sha256)throw Error('此版本已停止分发或有更新版本，请重新检查更新');
  if(compareVersions(release.artifact.version,this.version)<=0)throw Error('只能安装比当前版本更新的正式版');
  if(!await this.matches(this.file(),release.artifact)){this.set({status:'error'});throw Error('安装文件已变化，请重新下载');}return this.file();
 }
 start(){this.startTimer=setTimeout(()=>void this.check(),15000);this.startTimer.unref();this.timer=setInterval(()=>void this.check(),4*3600000);this.timer.unref();}
 close(){this.closed=true;clearTimeout(this.startTimer);clearInterval(this.timer);this.controller?.abort();}
}
export { Updater, hashFile };
