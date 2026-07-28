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
};
