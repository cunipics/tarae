// webview 내부 스크립트 실행 전 document-start 시점에 선제 주입되어 모든 알럿창 및 팝업 원천 차단
(function() {
  try {
    const noop = function() {};
    const returnTrue = function() { return true; };
    const returnNull = function() { return null; };

    // window.alert 차단
    Object.defineProperty(window, 'alert', {
      value: function(msg) {
        console.log('[Auto Blocked Alert]:', msg);
      },
      writable: false,
      configurable: false
    });

    // window.confirm 차단 (항상 true 반환하여 페이지 멈춤 방지)
    Object.defineProperty(window, 'confirm', {
      value: function(msg) {
        console.log('[Auto Blocked Confirm]:', msg);
        return true;
      },
      writable: false,
      configurable: false
    });

    // window.prompt 차단 (null 반환)
    Object.defineProperty(window, 'prompt', {
      value: function(msg) {
        console.log('[Auto Blocked Prompt]:', msg);
        return null;
      },
      writable: false,
      configurable: false
    });

    // window.open 차단 (웹뷰 내부 광고 팝업 생성 방지)
    Object.defineProperty(window, 'open', {
      value: function(url) {
        console.log('[Auto Blocked window.open]:', url);
        return null;
      },
      writable: false,
      configurable: false
    });

    // 페이지 이탈 방지 경고창(onbeforeunload) 무력화
    window.onbeforeunload = null;
  } catch (e) {}
})();

