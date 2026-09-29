/**
 * 스팸 학습 백그라운드 실시간 모니터링 관리자
 * - 우측 하단 플로팅 레이어를 통해 백그라운드 학습 진행 상황을 실시간 표시합니다.
 * - 어느 관리자 페이지로 이동해도 계속해서 진행 상황을 모니터링합니다.
 */

(function () {
  let pollInterval = null;
  let hideTimeout = null;

  async function checkSpamTrainStatus() {
    try {
      const res = await fetch('/mgr/api/spam/train-status');
      if (!res.ok) return;

      const result = await res.json();
      if (!result.success || !result.data) return;

      const state = result.data;
      updateUI(state);

    } catch (err) {
      // 통신 에러 시 무시
    }
  }

  function updateUI(state) {
    const container = document.getElementById('spam-progress-container');
    const bar = document.getElementById('spam-progress-bar');
    const percentEl = document.getElementById('spam-progress-percent');
    const textEl = document.getElementById('spam-status-text');
    const countsEl = document.getElementById('spam-progress-counts');
    const subEl = document.getElementById('spam-progress-sub');

    if (!container || !bar) return;

    if (state.status === 'running') {
      // 플로팅 레이어 노출
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      container.classList.remove('d-none');

      const pct = Math.max(state.percent || 1, 1);
      bar.style.width = pct + '%';
      bar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-success';
      if (percentEl) percentEl.textContent = pct + '%';
      if (textEl) textEl.textContent = '스팸 패턴 적재 중...';
      if (countsEl) countsEl.textContent = `${(state.current || 0).toLocaleString()} / ${(state.total || 0).toLocaleString()}건`;
      if (subEl) subEl.textContent = `신규 ${state.newCount || 0}건 (중복 ${state.duplicateCount || 0}건)`;

      // 스팸 학습 페이지에 있는 경우 상단 뱃지 갱신
      const memoryBadge = document.getElementById('memory-badge-top');
      if (memoryBadge) {
        memoryBadge.textContent = `메모리 적재 중: ${(state.current || 0).toLocaleString()}건`;
      }
      return;
    }

    if (state.status === 'completed') {
      bar.style.width = '100%';
      bar.className = 'progress-bar bg-success';
      if (percentEl) percentEl.textContent = '100%';
      if (textEl) textEl.textContent = '스팸 학습 완료!';
      if (countsEl) countsEl.textContent = `총 ${(state.total || 0).toLocaleString()}건 완료`;
      if (subEl) subEl.textContent = `신규 ${state.newCount || 0}건 적재됨`;

      // 완료 후 3초 뒤 자동 숨김
      if (!hideTimeout) {
        hideTimeout = setTimeout(() => {
          container.classList.add('d-none');
          hideTimeout = null;

          // 만약 스팸 학습 페이지라면 목록 자동 새로고침
          if (typeof window.fetchSpamList === 'function') {
            window.fetchSpamList(1);
          }
        }, 3000);
      }
      return;
    }

    if (state.status === 'idle') {
      if (!hideTimeout) {
        container.classList.add('d-none');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    checkSpamTrainStatus();
    pollInterval = setInterval(checkSpamTrainStatus, 1500);
  });
})();
