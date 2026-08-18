window.dataLayer = window.dataLayer || [];
window.gtag = function gtag(){ window.dataLayer.push(arguments); };
window.gtag('js', new Date());
window.gtag('config', 'G-KL8KKCGV9M', { send_page_view: false });
const visitorId = () => {
  let value = localStorage.getItem('s3xVisitorId');
  if (!value) { value = crypto.randomUUID(); localStorage.setItem('s3xVisitorId', value); }
  return value;
};
const sendPresence = () => {
  if (document.visibilityState !== 'visible' || location.pathname.startsWith('/admin')) return;
  fetch('/api/presence', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: visitorId(), page: `${location.pathname}${location.search}`.slice(0, 300) }) }).catch(()=>{});
};
window.trackPageView = function trackPageView(){
  window.gtag('event', 'page_view', {
    page_title: document.title,
    page_location: window.location.href,
    page_path: `${window.location.pathname}${window.location.search}`
  });
  if (!window.location.pathname.startsWith('/admin')) {
    fetch('/api/visits', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId: visitorId(), page: `${location.pathname}${location.search}`.slice(0, 300), referrer: document.referrer.slice(0, 500), language: navigator.language, screen: `${screen.width}x${screen.height}` }) }).catch(()=>{});
    sendPresence();
  }
};
setInterval(sendPresence, 30000);
document.addEventListener('visibilitychange', sendPresence);
