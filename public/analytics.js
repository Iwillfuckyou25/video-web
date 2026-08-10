window.dataLayer = window.dataLayer || [];
window.gtag = function gtag(){ window.dataLayer.push(arguments); };
window.gtag('js', new Date());
window.gtag('config', 'G-KL8KKCGV9M', { send_page_view: false });
window.trackPageView = function trackPageView(){
  window.gtag('event', 'page_view', {
    page_title: document.title,
    page_location: window.location.href,
    page_path: `${window.location.pathname}${window.location.search}`
  });
  if (!window.location.pathname.startsWith('/admin')) {
    let visitorId = localStorage.getItem('s3xVisitorId');
    if (!visitorId) { visitorId = crypto.randomUUID(); localStorage.setItem('s3xVisitorId', visitorId); }
    fetch('/api/visits', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId, page: `${location.pathname}${location.search}`.slice(0, 300), referrer: document.referrer.slice(0, 500), language: navigator.language, screen: `${screen.width}x${screen.height}` }) }).catch(()=>{});
  }
};
