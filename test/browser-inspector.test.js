const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const browserInspector = require('../service/browserInspector');

test('브라우저 실행 후 만들어진 게시물 링크와 HTML을 수집한다', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><div id="app"></div><script>
      let currentPage = 1;
      function render() {
        const id = currentPage === 1 ? 123 : 124;
        const disabled = currentPage === 2 ? 'disabled' : '';
        document.querySelector('#app').innerHTML =
          '<ul><li><a href="/board/news/view/' + id + '">게시물 제목 ' + currentPage + '</a></li></ul>' +
          '<nav class="paging_wrap"><button class="paging_num is-active" aria-current="page">' + currentPage + '</button>' +
          '<button type="button" class="paging_next" aria-label="다음 페이지" ' + disabled + '>다음</button></nav>';
        document.querySelector('.paging_next').addEventListener('click', () => {
          if (currentPage < 2) { currentPage++; render(); }
        });
      }
      setTimeout(() => {
        render();
      }, 30);
    </script></body></html>`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const details = await browserInspector.inspectPageDetails(`${origin}/board/news/list`, 5000);
    assert.equal(details.links.some(link => link.href === `${origin}/board/news/view/123`), true);
    assert.equal(details.links.some(link => link.href === `${origin}/board/news/view/124`), true);
    assert.match(details.html, /게시물 제목 1/);
  } finally {
    await browserInspector.closeBrowser();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('다음 버튼 없이 숫자 버튼만 있는 동적 게시판도 끝까지 수집한다', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><div id="app"></div><script>
      let currentPage = 1;
      function render() {
        document.querySelector('#app').innerHTML =
          '<a href="/board/story/view/' + (200 + currentPage) + '">글 ' + currentPage + '</a>' +
          '<nav aria-label="pagination navigation">' + [1, 2, 3].map(page =>
            '<span role="button" ' + (page === currentPage ? 'aria-current="page"' : '') + '>' + page + '</span>'
          ).join('') + '</nav>';
        document.querySelectorAll('[role="button"]').forEach(button => {
          button.addEventListener('click', () => { currentPage = Number(button.textContent); render(); });
        });
      }
      setTimeout(render, 30);
    </script></body></html>`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const details = await browserInspector.inspectPageDetails(`${origin}/board/story/list`, 5000);
    const articleLinks = details.links
      .map(link => link.href)
      .filter(href => href.includes('/board/story/view/'));
    assert.deepEqual(articleLinks, [
      `${origin}/board/story/view/201`,
      `${origin}/board/story/view/202`,
      `${origin}/board/story/view/203`
    ]);
  } finally {
    await browserInspector.closeBrowser();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('정적 페이지 검사는 페이지 스크립트를 실행하지 않는다', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><p>정적 내용</p><script>
      document.body.insertAdjacentHTML('beforeend', '<a href="/executed">실행됨</a>');
    </script></body></html>`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const details = await browserInspector.inspectPageDetails(
      `http://127.0.0.1:${address.port}/static`,
      5000,
      { waitForDynamicNetwork: false, collectDynamicPagination: false }
    );
    assert.equal(details.links.some(link => link.href.endsWith('/executed')), false);
  } finally {
    await browserInspector.closeBrowser();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
