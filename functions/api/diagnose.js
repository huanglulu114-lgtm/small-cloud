// Human-readable, zero-token diagnostic page. Unlike JSON navigation, this
// always renders useful HTML before any asynchronous request completes.
// Keep this outside the SPA so a cached Vue bundle is not required.
const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>小手机连接检测</title>
  <style>
    :root { color-scheme: light dark; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
    body { padding: 20px; margin: 0 auto; max-width: 640px; line-height: 1.7; }
    h1 { font-size: 23px; margin-top: 12px; }
    .card { border:1px solid #aaa7; border-radius:14px; padding:16px; margin:20px 0; overflow-wrap:anywhere; }
    .muted { opacity: .75; font-size:14px; }
    .error { color: #b33c2c; }
    .ok { color: #288247; }
    button,a { font:inherit; }
    button { padding:10px 15px; border:1px solid #aaa; border-radius:9px; background:transparent; cursor:pointer; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; }
  </style>
</head>
<body>
  <h1>小手机 · 连接检测</h1>
  <p>这张页面独立于聊天程序。检查不会发送聊天记录，也不会请求 AI 生成回复。</p>
  <div class="card">
    <strong>页面已正常打开</strong>
    <div class="muted">检测页面版本：diagnostic-html-2026-11-17-v1</div>
    <p id="status">正在检查后台连接……</p>
    <pre id="detail"></pre>
  </div>
  <button type="button" id="again">重新检测</button>
  <p class="muted">如果这里一直显示「正在检查」，说明脚本没有运行；如果显示网络失败，请检查 VPN 或 Cloudflare 登录状态。请勿清除 Safari 网站数据。</p>
  <p><a href="/">返回小手机</a></p>
  <script>
    (function () {
      var status=document.getElementById('status');
      var detail=document.getElementById('detail');
      function show(message,extra,isError) {
        status.textContent=message;
        status.className=isError?'error':'ok';
        detail.textContent=extra||'';
      }
      async function check() {
        status.textContent='正在联系小手机后台……';
        status.className='';
        detail.textContent='';
        var controller=new AbortController();
        var timer=setTimeout(function(){controller.abort();},18000);
        try {
          var response=await fetch('/api/chat?check=1', {
            credentials:'same-origin',cache:'no-store',signal:controller.signal,
            headers:{'Accept':'application/json'}
          });
          var contentType=response.headers.get('content-type')||'';
          if (contentType.indexOf('application/json')<0) {
            show('后台返回的不是检测结果（HTTP '+response.status+'）',
              '可能是 Cloudflare 登录页、网络拦截或网页缓存。请截图这个提示。',true);
            return;
          }
          var result=await response.json();
          var rows=['HTTP：'+response.status,'阶段：'+(result.stage||'未知')];
          if(result.openaiStatus)rows.push('OpenAI HTTP：'+result.openaiStatus);
          if(result.supportedModelAvailability) {
            rows.push('模型列表（仅显示当前密钥是否可见）：');
            Object.keys(result.supportedModelAvailability).forEach(function(key){
              rows.push('  '+key+'：'+(result.supportedModelAvailability[key]?'可见':'未列出'));
            });
          }
          if(result.version)rows.push('检测接口版本：'+result.version);
          var message=result.message || result.error || ('后台 HTTP '+response.status);
          show(message,rows.join('\n'),!result.ok);
        } catch(error) {
          show('无法连接检测接口', 
            '浏览器错误：'+(error&&error.name==='AbortError'?'请求超过18秒':(error.message||error.name||'未知'))+
            '\n这通常表示网络、VPN、登录拦截或后台请求中断，并不能证明聊天记录有问题。',true);
        } finally {
          clearTimeout(timer);
        }
      }
      document.getElementById('again').addEventListener('click',check);
      check();
    })();
  </script>
</body>
</html>`;
export async function onRequestGet() {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}
