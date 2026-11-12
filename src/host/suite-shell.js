function jsonForScript(value) {
  return JSON.stringify(value === undefined ? null : value).replace(/</g, '\\u003c')
}

/**
 * The document served inside the suite iframe.
 *
 * suite's runtime is a self-booting page: it reads window globals, builds its
 * own root and never exposes a teardown. Running it in a child document is the
 * only way to keep one owner of the parent's documentElement/lock. This shell
 * carries the globals and the tiny postMessage bridge; everything else is the
 * original splash.js served from the token route.
 */
export function buildSuiteShell({ base, nonce, config, template, template2, jump }) {
  const globals = {
    __DSH_STARTUP__: {
      ...config,
      enabled: true,
      mode: 'always',
      allowSkip: true,
      requireInteraction: false,
    },
    __DSH_STARTUP_TEMPLATE__: template,
    __DSH_STARTUP_TEMPLATE2__: template2 || null,
    __DSH_STARTUP_TPL_BASE__: base,
    __DSH_STARTUP_API_BASE__: base,
    __DSH_STARTUP_SCRIPT_URL__: base + '/splash.js',
    __DSH_STARTUP_JUMP__: jump || null,
  }
  const assignments = Object.keys(globals)
    .map((key) => `window.${key}=${jsonForScript(globals[key])};`)
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-boot-nexus suite</title>
<link rel="stylesheet" href="${base}/splash.css">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style>
</head><body>
<script>
${assignments}
(function(){
  var nonce=${jsonForScript(nonce)};
  var sentAudio=false;
  function post(type,extra){
    var msg={ns:'dbn-suite',v:1,nonce:nonce,type:type};
    if(extra) for(var k in extra) if(Object.prototype.hasOwnProperty.call(extra,k)) msg[k]=extra[k];
    try{ if(parent&&parent!==window) parent.postMessage(msg,'*'); }catch(e){}
  }
  try{
    window.addEventListener('dsh-startup:done',function(){ post('done'); });
    /* The suite's own iframe-template branch speaks the hyphenated event and
       the child frame posts that same name; accept both spellings so a done
       signal is never lost and the host does not fall through to a timeout. */
    window.addEventListener('dsh-startup-done',function(){ post('done'); });
    window.addEventListener('dsh-startup:skip',function(){ post('done'); });
    window.addEventListener('dsh-startup-skip',function(){ post('done'); });
    window.addEventListener('message',function(e){
      var d=e&&e.data;
      if(d&&typeof d==='object'&&(d.type==='dsh-startup-done'||d.type==='dsh-startup-skip')) post('done');
    });
    window.addEventListener('dsh-startup:act',function(e){ post('act',{act:(e&&e.detail&&e.detail.act)||0}); });
    window.addEventListener('error',function(e){
      post('error',{detail:String((e&&e.message)||'frame error').slice(0,500)});
    });
    window.addEventListener('unhandledrejection',function(e){
      post('error',{detail:String((e&&e.reason&&e.reason.message)||e.reason||'unhandled rejection').slice(0,500)});
    });
    var proto=window.HTMLMediaElement&&window.HTMLMediaElement.prototype;
    if(proto&&proto.play){
      var original=proto.play;
      proto.play=function(){
        var self=this;
        try{
          var p=original.apply(self,arguments);
          if(p&&typeof p.catch==='function') p.catch(function(){ if(!sentAudio){sentAudio=true;post('audio-blocked');} });
          return p;
        }catch(err){ if(!sentAudio){sentAudio=true;post('audio-blocked');} throw err; }
      };
    }
  }catch(e){}
  function ready(){ post('ready'); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',ready);
  else ready();
})();
</script>
<script src="${base}/splash.js"></script>
</body></html>`
}
