
var Sf1779Web = (() => {
  var _scriptName = import.meta.url;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

function aa(){h.buffer!=k.buffer&&l();return k}function n(){h.buffer!=k.buffer&&l();return ba}function p(){h.buffer!=k.buffer&&l();return ca}function q(){h.buffer!=k.buffer&&l();return da}function ea(){h.buffer!=k.buffer&&l();return fa}var r=moduleArg,t,u,ha=new Promise((a,b)=>{t=a;u=b}),ia="object"==typeof window,v="function"==typeof importScripts,ja="object"==typeof process&&"object"==typeof process.ga&&"string"==typeof process.ga.node,x=v&&"em-pthread"==self.name;r.listen||(r.listen=a=>console.log(a));
r.onError||(r.onError=a=>console.error(a));r.getRecommendedNnue=(a=0)=>ka(la(a));r.setNnueBuffer=function(a,b=0){if(!a)throw Error("buf is null");if(0>=a.byteLength)throw Error(`${a.byteLength} bytes?`);const c=y(a.byteLength);if(!c)throw Error(`could not allocate ${a.byteLength} bytes`);r.HEAPU8.set(a,c);ma(c,a.byteLength,b)};r.uci=function(a){const b=na(a)+1,c=y(b);if(!c)throw Error(`Could not allocate ${b} bytes`);z(a,c,b);oa(c)};r.print=a=>r.listen?.(a);r.printErr=a=>r.onError?.(a);
var pa=Object.assign({},r),qa=[],A="",ra,B;
if(ia||v)v?A=self.location.href:"undefined"!=typeof document&&document.currentScript&&(A=document.currentScript.src),_scriptName&&(A=_scriptName),A.startsWith("blob:")?A="":A=A.substr(0,A.replace(/[?#].*/,"").lastIndexOf("/")+1),v&&(B=a=>{var b=new XMLHttpRequest;b.open("GET",a,!1);b.responseType="arraybuffer";b.send(null);return new Uint8Array(b.response)}),ra=a=>fetch(a,{credentials:"same-origin"}).then(b=>b.ok?b.arrayBuffer():Promise.reject(Error(b.status+" : "+b.url)));
var sa=r.print||console.log.bind(console),C=r.printErr||console.error.bind(console);Object.assign(r,pa);pa=null;
if(x){var ta,ua=!1;function a(...c){console.error(c.join(" "))}r.printErr||(C=a);self.alert=function(...c){postMessage({ca:"alert",text:c.join(" "),ka:D()})};r.instantiateWasm=(c,d)=>new Promise(f=>{ta=e=>{e=new WebAssembly.Instance(e,va());d(e);f()}});self.onunhandledrejection=c=>{throw c.reason||c;};function b(c){try{var d=c.data,f=d.cmd;if("load"===f){let e=[];self.onmessage=g=>e.push(g);self.startWorker=()=>{postMessage({cmd:"loaded"});for(let g of e)b(g);self.onmessage=b};for(const g of d.handlers)if(!r[g]||
r[g].proxy)r[g]=(...m)=>{postMessage({ca:"callHandler",ja:g,ia:m})},"print"==g&&(sa=r[g]),"printErr"==g&&(C=r[g]);h=d.wasmMemory;l();ta(d.wasmModule)}else if("run"===f){E(d.pthread_ptr,0,0,1,0,0);F(d.pthread_ptr);wa();xa();ua||=!0;try{ya(d.start_routine,d.arg)}catch(e){if("unwind"!=e)throw e;}}else"cancel"===f?D()&&G(-1):"setimmediate"!==d.target&&("checkMailbox"===f?ua&&H():f&&(C(`worker: received unknown command ${f}`),C(d)))}catch(e){throw za(),e;}}self.onmessage=b}var h,Aa,I=!1,J,k,ba,ca,da,fa;
function l(){var a=h.buffer;k=new Int8Array(a);new Int16Array(a);r.HEAPU8=ba=new Uint8Array(a);new Uint16Array(a);ca=new Int32Array(a);da=new Uint32Array(a);new Float32Array(a);fa=new Float64Array(a)}
if(!x){if(r.wasmMemory)h=r.wasmMemory;else if(h=new WebAssembly.Memory({initial:1024,maximum:32768,shared:!0}),!(h.buffer instanceof SharedArrayBuffer))throw C("requested a shared WebAssembly.Memory but the returned buffer is not a SharedArrayBuffer, indicating that while the browser has SharedArrayBuffer it does not have WebAssembly threads support - you may need to set a flag"),ja&&C("(on node you may need: --experimental-wasm-threads --experimental-wasm-bulk-memory and/or recent version)"),Error("bad memory");
l()}var Ba=[],K=[],Ca=[],Da=[],Ea=[],Fa=!1,L=0,Ga=null,M=null;function Ha(){L--;if(0==L&&(null!==Ga&&(clearInterval(Ga),Ga=null),M)){var a=M;M=null;a()}}function Ia(a){a="Aborted("+a+")";C(a);I=!0;J=1;a=new WebAssembly.RuntimeError(a+". Build with -sASSERTIONS for more info.");u(a);throw a;}var Ja=a=>a.startsWith("data:application/octet-stream;base64,"),Ka;
function La(a){return ra(a).then(b=>new Uint8Array(b),()=>{if(B)var b=B(a);else throw"both async and sync fetching of the wasm failed";return b})}function Ma(a,b,c){return La(a).then(d=>WebAssembly.instantiate(d,b)).then(c,d=>{C(`failed to asynchronously prepare wasm: ${d}`);Ia(d)})}
function Na(a,b){var c=Ka;return"function"!=typeof WebAssembly.instantiateStreaming||Ja(c)||"function"!=typeof fetch?Ma(c,a,b):fetch(c,{credentials:"same-origin"}).then(d=>WebAssembly.instantiateStreaming(d,a).then(b,function(f){C(`wasm streaming compile failed: ${f}`);C("falling back to ArrayBuffer instantiation");return Ma(c,a,b)}))}
function va(){Oa={C:Pa,f:Qa,x:Ra,y:Sa,m:Ta,D:Ua,k:Va,B:Wa,i:Xa,p:Ya,g:Za,j:F,h:$a,q:ab,s:bb,d:cb,l:db,c:eb,r:fb,A:gb,v:hb,t:ib,u:jb,b:N,e:kb,w:lb,n:mb,z:nb,a:h,o:ob};return{a:Oa}}function pb(a){this.name="ExitStatus";this.message=`Program terminated with exit(${a})`;this.status=a}
var qb=a=>{a.terminate();a.onmessage=()=>{}},tb=a=>{0==O.length&&(rb(),sb(O[0]));var b=O.pop();if(!b)return 6;P.push(b);Q[a.aa]=b;b.aa=a.aa;b.postMessage({cmd:"run",start_routine:a.ea,arg:a.da,pthread_ptr:a.aa},a.fa);return 0},R=0,hb=()=>0<R,T=(a,b,...c)=>{for(var d=c.length,f=ub(),e=S(8*d),g=e>>3,m=0;m<c.length;m++){var w=c[m];ea()[g+m]=w}a=vb(a,0,d,e,b);wb(f);return a};function ob(a){if(x)return T(0,1,a);J=a;0<R||(xb(),I=!0);throw new pb(a);}
var Ab=a=>{if(!(a instanceof pb||"unwind"==a))throw a;};function Bb(a){if(x)return T(1,0,a);--R;N(a)}var N=a=>{J=a;if(x)throw Bb(a),"unwind";0<R||x||(Cb(),U(Da),Db(0),Eb[1].length&&Fb(1,10),Eb[2].length&&Fb(2,10),xb(),Fa=!0);ob(a)},O=[],P=[],Gb=[],Q={};function Hb(){for(var a=navigator.hardwareConcurrency;a--;)rb();Ba.unshift(()=>{L++;Ib(()=>Ha())})}var xb=()=>{for(var a of P)qb(a);for(a of O)qb(a);O=[];P=[];Q=[]},Kb=a=>{var b=a.aa;delete Q[b];O.push(a);P.splice(P.indexOf(a),1);a.aa=0;Jb(b)};
function xa(){Gb.forEach(a=>a())}
var sb=a=>new Promise(b=>{a.onmessage=e=>{e=e.data;var g=e.cmd;if(e.targetThread&&e.targetThread!=D()){var m=Q[e.targetThread];m?m.postMessage(e,e.transferList):C(`Internal error! Worker sent a message "${g}" to target pthread ${e.targetThread}, but that thread no longer exists!`)}else if("checkMailbox"===g)H();else if("spawnThread"===g)tb(e);else if("cleanupThread"===g)Kb(Q[e.thread]);else if("killThread"===g)e=e.thread,g=Q[e],delete Q[e],qb(g),Jb(e),P.splice(P.indexOf(g),1),g.aa=0;else if("cancelThread"===
g)Q[e.thread].postMessage({cmd:"cancel"});else if("loaded"===g)a.loaded=!0,b(a);else if("alert"===g)alert(`Thread ${e.threadId}: ${e.text}`);else if("setimmediate"===e.target)a.postMessage(e);else if("callHandler"===g)r[e.handler](...e.args);else g&&C(`worker sent an unknown command ${g}`)};a.onerror=e=>{C(`${"worker sent an error!"} ${e.filename}:${e.lineno}: ${e.message}`);throw e;};var c=[],d=["print","printErr"],f;for(f of d)r.propertyIsEnumerable(f)&&c.push(f);a.postMessage({cmd:"load",handlers:c,
wasmMemory:h,wasmModule:Aa})});function Ib(a){x?a():Promise.all(O.map(sb)).then(a)}function rb(){var a=new Worker(new URL("sf17-79.js",import.meta.url),{type:"module",name:"em-pthread"});O.push(a)}var U=a=>{for(;0<a.length;)a.shift()(r)},wa=()=>{var a=D(),b=q()[a+52>>2];a=q()[a+56>>2];Lb(b,b-a);wb(b)},V=[],Mb,ya=(a,b)=>{R=0;var c=V[a];c||(a>=V.length&&(V.length=a+1),V[a]=c=Mb.get(a));a=c(b);0<R?J=a:G(a)};function Nb(a,b,c,d){return x?T(2,1,a,b,c,d):Pa(a,b,c,d)}
var Pa=(a,b,c,d)=>{if("undefined"==typeof SharedArrayBuffer)return C("Current environment does not support SharedArrayBuffer, pthreads are not available!"),6;var f=[];if(x&&0===f.length)return Nb(a,b,c,d);a={ea:c,aa:a,da:d,fa:f};return x?(a.ca="spawnThread",postMessage(a,f),0):tb(a)},Ob="undefined"!=typeof TextDecoder?new TextDecoder:void 0,Pb=(a,b,c)=>{var d=b+c;for(c=b;a[c]&&!(c>=d);)++c;if(16<c-b&&a.buffer&&Ob)return Ob.decode(a.buffer instanceof SharedArrayBuffer?a.slice(b,c):a.subarray(b,c));
for(d="";b<c;){var f=a[b++];if(f&128){var e=a[b++]&63;if(192==(f&224))d+=String.fromCharCode((f&31)<<6|e);else{var g=a[b++]&63;f=224==(f&240)?(f&15)<<12|e<<6|g:(f&7)<<18|e<<12|g<<6|a[b++]&63;65536>f?d+=String.fromCharCode(f):(f-=65536,d+=String.fromCharCode(55296|f>>10,56320|f&1023))}}else d+=String.fromCharCode(f)}return d},ka=(a,b)=>a?Pb(n(),a,b):"";function Qa(a,b,c){return x?T(3,1,a,b,c):0}function Ra(a,b,c){return x?T(4,1,a,b,c):0}function Sa(a,b,c,d){if(x)return T(5,1,a,b,c,d)}
var Ta=()=>{Ia("")},Ua=()=>1,Va=a=>{E(a,!v,1,!ia,2097152,!1);xa()},Qb=a=>{if(!Fa&&!I)try{if(a(),!(Fa||0<R))try{x?G(J):N(J)}catch(b){Ab(b)}}catch(b){Ab(b)}},F=a=>{"function"===typeof Atomics.ha&&(Atomics.ha(p(),a>>2,a).value.then(H),a+=128,Atomics.store(p(),a>>2,1))},H=()=>{var a=D();a&&(F(a),Qb(Rb))},Wa=(a,b)=>{a==b?setTimeout(H):x?postMessage({targetThread:a,cmd:"checkMailbox"}):(a=Q[a])&&a.postMessage({cmd:"checkMailbox"})},Sb=[],Xa=(a,b,c,d,f)=>{Sb.length=d;b=f>>3;for(c=0;c<d;c++)Sb[c]=ea()[b+
c];return(0,Tb[a])(...Sb)};function Ya(){if(x)return T(6,1);R=0}var Za=a=>{x?postMessage({cmd:"cleanupThread",thread:a}):Kb(Q[a])},$a=()=>{},W={},eb;eb=()=>performance.timeOrigin+performance.now();function ab(a,b){if(x)return T(7,1,a,b);W[a]&&(clearTimeout(W[a].id),delete W[a]);if(!b)return 0;var c=setTimeout(()=>{delete W[a];Qb(()=>Ub(a,eb()))},b);W[a]={id:c,la:b};return 0}
var z=(a,b,c)=>{var d=n();if(0<c){var f=b;c=b+c-1;for(var e=0;e<a.length;++e){var g=a.charCodeAt(e);if(55296<=g&&57343>=g){var m=a.charCodeAt(++e);g=65536+((g&1023)<<10)|m&1023}if(127>=g){if(b>=c)break;d[b++]=g}else{if(2047>=g){if(b+1>=c)break;d[b++]=192|g>>6}else{if(65535>=g){if(b+2>=c)break;d[b++]=224|g>>12}else{if(b+3>=c)break;d[b++]=240|g>>18;d[b++]=128|g>>12&63}d[b++]=128|g>>6&63}d[b++]=128|g&63}}d[b]=0;a=b-f}else a=0;return a},bb=(a,b,c,d)=>{var f=(new Date).getFullYear(),e=(new Date(f,0,1)).getTimezoneOffset();
f=(new Date(f,6,1)).getTimezoneOffset();var g=Math.max(e,f);q()[a>>2]=60*g;p()[b>>2]=Number(e!=f);b=m=>{var w=Math.abs(m);return`UTC${0<=m?"-":"+"}${String(Math.floor(w/60)).padStart(2,"0")}${String(w%60).padStart(2,"0")}`};a=b(e);b=b(f);f<e?(z(a,c,17),z(b,d,17)):(z(a,d,17),z(b,c,17))},X=()=>{X.ba||(X.ba={});X.ba["Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread"]||(X.ba["Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread"]=
1,C("Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread"))},cb=()=>{v||(X(),Ia("Blocking on the main thread is not allowed by default. See https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread"))},db=()=>{R+=1;throw"unwind";},fb=()=>navigator.hardwareConcurrency,gb=a=>{var b=n().length;a>>>=0;if(a<=b||2147483648<a)return!1;for(var c=1;4>=c;c*=2){var d=b*(1+.2/c);d=Math.min(d,a+100663296);
a:{d=(Math.min(2147483648,65536*Math.ceil(Math.max(a,d)/65536))-h.buffer.byteLength+65535)/65536;try{h.grow(d);l();var f=1;break a}catch(e){}f=void 0}if(f)return!0}return!1},Vb={},Xb=()=>{if(!Wb){var a={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:("object"==typeof navigator&&navigator.languages&&navigator.languages[0]||"C").replace("-","_")+".UTF-8",_:"./this.program"},b;for(b in Vb)void 0===Vb[b]?delete a[b]:a[b]=Vb[b];var c=[];for(b in a)c.push(`${b}=${a[b]}`);
Wb=c}return Wb},Wb;function ib(a,b){if(x)return T(8,1,a,b);var c=0;Xb().forEach((d,f)=>{var e=b+c;f=q()[a+4*f>>2]=e;for(e=0;e<d.length;++e)aa()[f++]=d.charCodeAt(e);aa()[f]=0;c+=d.length+1});return 0}function jb(a,b){if(x)return T(9,1,a,b);var c=Xb();q()[a>>2]=c.length;var d=0;c.forEach(f=>d+=f.length+1);q()[b>>2]=d;return 0}function kb(a){return x?T(10,1,a):52}function lb(a,b,c,d){return x?T(11,1,a,b,c,d):52}function mb(a,b,c,d,f){return x?T(12,1,a,b,c,d,f):70}
var Eb=[null,[],[]],Fb=(a,b)=>{var c=Eb[a];0===b||10===b?((1===a?sa:C)(Pb(c,0)),c.length=0):c.push(b)};function nb(a,b,c,d){if(x)return T(13,1,a,b,c,d);for(var f=0,e=0;e<c;e++){var g=q()[b>>2],m=q()[b+4>>2];b+=8;for(var w=0;w<m;w++)Fb(a,n()[g+w]);f+=m}q()[d>>2]=f;return 0}var na=a=>{for(var b=0,c=0;c<a.length;++c){var d=a.charCodeAt(c);127>=d?b++:2047>=d?b+=2:55296<=d&&57343>=d?(b+=4,++c):b+=3}return b};x||Hb();
var Tb=[ob,Bb,Nb,Qa,Ra,Sa,Ya,ab,ib,jb,kb,lb,mb,nb],Oa,Y=function(){function a(c,d){Y=c.exports;Gb.push(Y.K);Mb=Y.N;K.unshift(Y.E);Aa=d;Ha();return Y}var b=va();L++;if(r.instantiateWasm)try{return r.instantiateWasm(b,a)}catch(c){C(`Module.instantiateWasm callback failed with error: ${c}`),u(c)}Ka||=r.locateFile?Ja("sf17-79.wasm")?"sf17-79.wasm":r.locateFile?r.locateFile("sf17-79.wasm",A):A+"sf17-79.wasm":(new URL("sf17-79.wasm",import.meta.url)).href;Na(b,function(c){a(c.instance,c.module)}).catch(u);
return{}}();r._main=(a,b)=>(r._main=Y.F)(a,b);r.__Z10js_getlinev=a=>(r.__Z10js_getlinev=Y.G)(a);
var oa=r._uci=a=>(oa=r._uci=Y.H)(a),ma=r._setNnueBuffer=(a,b,c)=>(ma=r._setNnueBuffer=Y.I)(a,b,c),la=r._getRecommendedNnue=a=>(la=r._getRecommendedNnue=Y.J)(a),D=()=>(D=Y.L)(),Yb=r.__emscripten_proxy_main=(a,b)=>(Yb=r.__emscripten_proxy_main=Y.M)(a,b),Cb=()=>(Cb=Y.O)(),E=(a,b,c,d,f,e)=>(E=Y.P)(a,b,c,d,f,e),za=()=>(za=Y.Q)(),Db=a=>(Db=Y.R)(a),y=r._malloc=a=>(y=r._malloc=Y.S)(a),vb=(a,b,c,d,f)=>(vb=Y.T)(a,b,c,d,f),Jb=a=>(Jb=Y.U)(a),G=a=>(G=Y.V)(a),Ub=(a,b)=>(Ub=Y.W)(a,b),Rb=()=>(Rb=Y.X)(),Lb=(a,b)=>
(Lb=Y.Y)(a,b),wb=a=>(wb=Y.Z)(a),S=a=>(S=Y._)(a),ub=()=>(ub=Y.$)();r.UTF8ToString=ka;r.stringToUTF8=z;var Z;M=function Zb(){Z||$b();Z||(M=Zb)};function ac(a=[]){var b=Yb;R+=1;a.unshift("./this.program");var c=a.length,d=S(4*(c+1)),f=d;a.forEach(g=>{var m=q(),w=f>>2,yb=na(g)+1,zb=S(yb);z(g,zb,yb);m[w]=zb;f+=4});q()[f>>2]=0;try{var e=b(c,d);N(e,!0)}catch(g){Ab(g)}}
function $b(){0<L||(x?(t(r),x||U(K),startWorker(r)):(U(Ba),0<L||Z||(Z=!0,r.calledRun=!0,I||(x||U(K),x||U(Ca),t(r),bc&&ac(qa),x||U(Ea)))))}var bc=!0;$b();moduleRtn=ha;


  return moduleRtn;
}
);
})();
export default Sf1779Web;
var isPthread = globalThis.self?.name === 'em-pthread';
// When running as a pthread, construct a new instance on startup
isPthread && Sf1779Web();