import crypto from 'node:crypto';
const MAX_PACKAGE = 768 * 1024 * 1024;
function versionParts(value) {
  const match = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]{1,40}))?$/.exec(String(value));
  if (!match) throw Error('版本号格式无效');
  return { numbers: match.slice(1,4).map(Number), pre: match[4] || '' };
}
function compareVersions(a,b) {
  const x=versionParts(a),y=versionParts(b);
  for(let i=0;i<3;i++)if(x.numbers[i]!==y.numbers[i])return Math.sign(x.numbers[i]-y.numbers[i]);
  if(x.pre===y.pre)return 0;
  if(!x.pre||!y.pre)return x.pre?-1:1;
  const p=x.pre.split('.'),q=y.pre.split('.');
  for(let i=0;i<Math.max(p.length,q.length);i++){
    if(p[i]===q[i])continue;if(p[i]===undefined)return -1;if(q[i]===undefined)return 1;
    const pn=/^\d+$/.test(p[i]),qn=/^\d+$/.test(q[i]);
    if(pn&&qn)return Math.sign(Number(p[i])-Number(q[i]));if(pn!==qn)return pn?-1:1;
    return p[i]<q[i]?-1:1;
  }return 0;
}
function verifyArtifact(envelope,publicKey) {
  if(!envelope||typeof envelope.payload!=='string'||envelope.payload.length>12000||typeof envelope.signature!=='string'||envelope.signature.length>200)throw Error('更新签名文件无效');
  const bytes=Buffer.from(envelope.payload,'base64');
  if(!crypto.verify(null,bytes,publicKey,Buffer.from(envelope.signature,'base64')))throw Error('更新签名校验失败，请获取官方安装包');
  const a=JSON.parse(bytes.toString('utf8'));
  if(a.schema!==1||a.product!=='com.kua-yipu.workbench'||a.platform!=='win32'||a.arch!=='x64')throw Error('安装包不适用于此软件或系统');
  versionParts(a.version);
  if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.size)||a.size<2||a.size>MAX_PACKAGE)throw Error('安装包校验信息无效');
  if(a.filename!==`chaodekuai-${a.version}-setup.exe`)throw Error('安装包名称与版本不匹配');
  return a;
}
function signArtifact(artifact,key) {
  const bytes=Buffer.from(JSON.stringify(artifact));
  return {payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,key).toString('base64')};
}
export { MAX_PACKAGE, versionParts, compareVersions, verifyArtifact, signArtifact };
