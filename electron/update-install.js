import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
async function launchInstaller({file,directory,target,pid=process.pid,spawnImpl=spawn,timeout=60000}){
 const token=crypto.randomUUID(),ready=path.join(directory,'install-ready-'+token),result=path.join(directory,'install-result.txt');
 // No shell is involved. NSIS directory quoting is handled inside our signed bootstrap.
 const child=spawnImpl(file,['/S','/update-parent='+pid,'/update-ready='+ready,'/update-result='+result,'/restart','/D='+target],{detached:true,stdio:'ignore',windowsHide:true});
 let error,exited=false;child.once('error',e=>{error=e;});child.once('exit',()=>{exited=true;});
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(error)throw Error('无法启动更新安装程序：'+error.message);
  if(fs.existsSync(ready)){const contents=fs.readFileSync(ready,'utf8').replace(/^\ufeff/,'');if(contents.trim()==='ready'){fs.unlinkSync(ready);child.unref();return {result};}}
  if(exited)throw Error('更新安装检查未通过，当前软件仍可使用，请查看安装日志');
  await new Promise(r=>setTimeout(r,100));
 }
 // Stop only this installer before its parent-exit handshake, never the running app.
 child.kill();throw Error('启动更新安装程序超时，软件保持打开，请重试');
}
export { launchInstaller };
