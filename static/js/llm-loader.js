/**
 * AI 탐지 모델(3종 q8) 실시간 로딩 상태 관리자
 * - Xenova/multilingual-e5-small (q8)
 * - Xenova/opus-mt-ko-en (q8)
 * - onnx-community/Qwen2.5-0.5B-Instruct (q8)
 */

(function () {
  window.isLLMReady = false;
  let pollInterval = null;

  function updateRunnerPosition(progress) {
    const runnerEl = document.getElementById('llm-runner-pack');
    if (!runnerEl) return;

    const numericProgress = Number(progress);
    const pct = Number.isFinite(numericProgress)
      ? Math.min(100, Math.max(0, numericProgress))
      : 0;

    runnerEl.style.left = pct + '%';
    runnerEl.style.transform = 'translateX(-' + pct + '%)';
  }

  function updateUI(statusData) {
    const barEl = document.getElementById('llm-progress-bar');
    const percentEl = document.getElementById('llm-progress-percent');
    const textEl = document.getElementById('llm-status-text');
    const badgeEl = document.getElementById('llm-ready-badge');
    const containerEl = document.getElementById('llm-progress-container');

    if (statusData.status === 'ready' || statusData.progress >= 100) {
      window.isLLMReady = true;
      sessionStorage.setItem('llm_ready', 'Y');

      // 로딩 완료 시 하단 플로팅 레이어 자동 숨김
      if (containerEl) {
        containerEl.classList.add('d-none');
        containerEl.classList.remove('llm-load-error');
      }

      updateRunnerPosition(100);

      // 상단 헤더에만 "AI 모델 준비 완료, 엔진 가동 중" 상시 유지
      if (badgeEl) {
        badgeEl.className = 'badge text-bg-success';
        badgeEl.textContent = 'AI 모델 준비 완료, 엔진 가동 중';
      }

      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      return;
    }

    if (statusData.status === 'loading' || statusData.status === 'idle') {
      window.isLLMReady = false;
      sessionStorage.removeItem('llm_ready');

      const pct = Math.max(statusData.progress || 5, 5);

      // 로딩 중일 때는 하단 플로팅 레이어 표시
      if (containerEl) {
        containerEl.classList.remove('d-none');
        containerEl.classList.remove('llm-load-error');
      }

      updateRunnerPosition(pct);

      if (barEl) {
        barEl.style.width = pct + '%';
        barEl.className = 'progress-bar progress-bar-striped progress-bar-animated bg-primary';
      }

      if (percentEl) {
        percentEl.textContent = pct + '%';
        percentEl.className = 'fw-bold text-primary ms-2';
      }

      if (textEl) {
        textEl.textContent = statusData.detail || 'AI 모델 적재 중...';
        textEl.className = 'small fw-semibold text-truncate';
      }

      if (badgeEl) {
        badgeEl.className = 'badge text-bg-warning';
        badgeEl.textContent = `모델 로딩 중 (${pct}%)`;
      }
    } else if (statusData.status === 'error') {
      window.isLLMReady = false;
      if (containerEl) {
        containerEl.classList.remove('d-none');
        containerEl.classList.add('llm-load-error');
      }
      if (barEl) barEl.className = 'progress-bar bg-danger';
      if (textEl) textEl.textContent = '오류: ' + (statusData.detail || '모델 로딩 실패');
      if (badgeEl) {
        badgeEl.className = 'badge text-bg-danger';
        badgeEl.textContent = '모델 로딩 오류';
      }
    }
  }

  async function checkServerStatus() {
    try {
      const res = await fetch('/mgr/api/model-status');
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'idle') {
        fetch('/mgr/api/model-init', { method: 'POST' });
        data.status = 'loading';
        data.progress = 5;
        data.detail = 'AI 탐지 모델 초기화 시작...';
      }

      updateUI(data);

      if (data.status === 'loading' && !pollInterval) {
        pollInterval = setInterval(checkServerStatus, 1500);
      }
    } catch (e) {
      console.warn('[LLM Loader] 상태 확인 실패:', e);
    }
  }

  // 전역 가드 함수: 로딩 완료 전 기능 실행 차단
  window.checkLLMReady = function (customMessage) {
    if (!window.isLLMReady) {
      alert(customMessage || 'AI 탐지 모델(3종 q8)이 아직 로딩 중입니다.\n로딩이 완료된 후 다시 시도해 주세요.');
      return false;
    }
    return true;
  };

  document.addEventListener('DOMContentLoaded', function () {
    // 세션 스토리지에 캐시된 완료 상태가 있으면 깜빡임 없이 즉시 100% 반영
    if (sessionStorage.getItem('llm_ready') === 'Y') {
      updateUI({
        status: 'ready',
        progress: 100,
        detail: 'AI 모델 준비 완료, 엔진 가동 중'
      });
    }

    checkServerStatus();

    // 1. 검색 폼 전송 가드
    document.addEventListener('submit', function (e) {
      const form = e.target;
      if (form.matches('form[role="search"]') || form.classList.contains('navbar-search') || form.querySelector('input[type="search"]')) {
        if (!window.checkLLMReady('AI 탐지 모델이 아직 로딩 중입니다.\n로딩이 완료된 후 검색 기능을 이용해 주세요.')) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }
    }, true);

    // 2. 재점검 및 신규 탐지 버튼 클릭 가드 (이벤트 위임)
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('button, a');
      if (!btn) return;

      const title = btn.getAttribute('title') || '';
      const text = btn.textContent || '';

      // 재점검 버튼인 경우
      if (title.includes('재점검') || text.includes('재점검') || btn.querySelector('.bi-arrow-clockwise')) {
        if (!window.checkLLMReady('AI 탐지 모델이 아직 로딩 중입니다.\n로딩 완료 후 재점검을 수행할 수 있습니다.')) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }

      // 신규 탐지 시작 버튼인 경우
      if (text.includes('신규 탐지') || title.includes('신규 탐지') || btn.querySelector('.bi-shield-plus')) {
        if (!window.checkLLMReady('AI 탐지 모델이 아직 로딩 중입니다.\n로딩 완료 후 신규 탐지를 시작할 수 있습니다.')) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }
    }, true);
  });
})();
