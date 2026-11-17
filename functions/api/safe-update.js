// An explicitly initiated, data-preserving repair route for stale Safari PWA
// shells. Requires normal Cloudflare Access at the edge; never reads local
// conversations, LocalStorage, IndexedDB, cookies or credentials.
const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>小手机 · 安全更新</title>
<style>
  body{margin:0;padding:48px 22px;max-width:480px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f4f5f7;color:#263649}
  h1{font-size:24px;margin:0 0 10px}p{font-size:15px;color:#596879}
  button{display:block;width:100%;border:0;border-radius:14px;background:#587b96;color:white;font:600 17px -apple-system,sans-serif;padding:16px;margin:26px 0 12px}
  button:disabled{opacity:.5}
  #result{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border-radius:12px;background:white;font-size:14px}
  a{color:#326eaa}strong{color:#263649}
</style>
</head>
<body>
<h1>小手机 · 安全更新</h1>
<p>如果「设置 → 聊天 API」看不到最新的检测按钮，可以在这里手动更新网页文件。</p>
<p><strong>不会清除聊天记录、角色、图片、设置或 IndexedDB。</strong>只停用本站旧的离线网页缓存和 Service Worker，然后重新进入小手机。</p>
<button id="repair" type="button">安全更新网页（不删除聊天记录）</button>
<div id="result" role="status">页面已打开。点击上方按钮才会执行更新。</div>
<p><a href="/">不更新，返回小手机</a></p>
<script>
(function(){
  var button=document.getElementById("repair");
  var result=document.getElementById("result");
  button.addEventListener("click",async function(){
    button.disabled=true;
    result.textContent="正在更新网页文件，请勿关闭本页面……";
    try{
      var removedSW=0,removedCaches=0;
      if("serviceWorker" in navigator){
        var registrations=await navigator.serviceWorker.getRegistrations();
        for(var i=0;i<registrations.length;i++){
          var reg=registrations[i];
          // Only this origin's PWA registrations; no other browser data.
          if(new URL(reg.scope).origin === location.origin){
            if(await reg.unregister())removedSW++;
          }
        }
      }
      if("caches" in window){
        var names=await caches.keys();
        for(var j=0;j<names.length;j++){
          // Only Workbox/VitePWA-managed offline app-asset caches.
          if(/^(?:workbox-precache|workbox-runtime|vite-pwa|workbox-)/i.test(names[j])){
            if(await caches.delete(names[j]))removedCaches++;
          }
        }
      }
      result.textContent="网页缓存更新完成。\n已停用旧离线服务："+removedSW+"；已清理旧应用缓存："+removedCaches+"。\n本地聊天数据未触碰。即将返回小手机。";
      location.replace("/?safe_update=20261117");
    }catch(error){
      result.textContent="更新中遇到问题："+String(error&&error.message||error)+"。\n没有清除聊天数据库。请截图这段文字。";
      button.disabled=false;
    }
  });
})();
</script>
</body></html>`;
export async function onRequestGet() {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}
