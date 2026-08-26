// GA4 手動ページビュー（静的ページのため1回のみ）
if(typeof gtag === 'function'){
  gtag('event', 'page_view', {
    page_title: document.title,
    page_location: location.href,
    page_path: location.pathname,
  });
}

// Sticky nav on scroll
// #main-navが無いページで例外が発生すると、以降に登録するはずだった
// ハンバーガーメニュー・FAQアコーディオン・GA4クリック計測の登録が
// サイレントに失敗していた（Opus 5監査 エンジニアM-8）。要素の有無を必ずガードする。
let _scrollTick = false;
window.addEventListener('scroll', () => {
  if(!_scrollTick){
    requestAnimationFrame(() => {
      document.getElementById('main-nav')?.classList.toggle('scrolled', window.scrollY > 10);
      _scrollTick = false;
    });
    _scrollTick = true;
  }
}, { passive: true });

// ハンバーガーメニュー
function toggleMenu(forceClose, returnFocus = true){
  const h = document.getElementById('hamburger');
  const m = document.getElementById('mobile-menu');
  if(!h || !m) return;
  const isOpen = forceClose ? false : !m.classList.contains('open');
  h.classList.toggle('open', isOpen);
  m.classList.toggle('open', isOpen);
  h.setAttribute('aria-expanded', isOpen);
  h.setAttribute('aria-label', isOpen ? 'メニューを閉じる' : 'メニューを開く');
  m.setAttribute('aria-hidden', !isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
  if(isOpen){
    const firstLink = m.querySelector('a, button');
    if(firstLink) firstLink.focus();
  } else if(returnFocus){
    h.focus();
  }
}
document.getElementById('hamburger')?.addEventListener('click', () => toggleMenu());
document.querySelectorAll('#mobile-menu a').forEach(a => a.addEventListener('click', () => toggleMenu(true)));
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    const m = document.getElementById('mobile-menu');
    if(m.classList.contains('open')) toggleMenu(true);
  }
});

// FAQ アコーディオン
document.addEventListener('click', e => {
  const btn = e.target.closest('.faq-q');
  if(!btn) return;
  const item = btn.closest('.faq-item');
  if(!item) return;
  const isOpen = item.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen);
});

// スクロールリビール
(function(){
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: .12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
})();

// GA4 クリック計測（LINE / Instagram 導線）
document.addEventListener('click', (e) => {
  if(typeof gtag !== 'function') return;
  const a = e.target.closest('a[href]');
  if(!a) return;
  if(a.href.includes('lin.ee')){
    gtag('event', 'line_click', { link_url: a.href, page_path: location.pathname });
  } else if(a.href.includes('instagram.com')){
    gtag('event', 'instagram_click', { link_url: a.href, page_path: location.pathname });
  }
});
