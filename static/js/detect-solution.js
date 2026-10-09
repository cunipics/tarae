(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcmsSolution = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  const placements = {
    wordpress: ['워드프레스', '자식 테마의 공통 머리글 또는 헤더 코드 삽입 기능에 넣고, 해당 사이트에서만 출력하세요.'],
    gnuboard5: ['그누보드5', '사이트 공통 머리글 템플릿에 넣고, 해당 사이트에서만 출력하세요.'],
    xpressengine: ['XE·라이믹스', '사용 중인 레이아웃의 공통 머리글에 넣고, 해당 사이트에서만 출력하세요.'],
    egovframework: ['전자정부프레임워크', '공통 JSP 머리글 또는 레이아웃 템플릿에 넣고, 해당 사이트에서만 출력하세요.']
  };
  const remedies = {
    JAMO: '원본 게시물에서 분해된 자모를 제거하고, 입력·검색 단계에서 유니코드 정규화를 적용하세요.',
    HOMOGLYPH: '원본 게시물의 닮은꼴 문자를 제거하고, 혼용 문자 탐지를 작성·검수 단계에 넣으세요.',
    TRANSPARENT: '원본 템플릿이나 게시물에서 투명 문구와 이를 숨기는 스타일을 함께 제거하세요.',
    OFFSCREEN: '원본 템플릿이나 게시물에서 화면 밖 문구와 위치 이동 스타일을 함께 제거하세요.',
    NONSTANDARD_PORT: '검색엔진에 노출된 비표준 포트의 서비스와 인증서 설정을 확인하고, 불필요한 포트는 외부 접근을 차단한 뒤 해당 색인의 삭제를 요청하세요.',
    REFLECTED_SEARCH: '검색 결과에 입력값을 그대로 출력하지 않도록 처리하고, 검색 결과 화면에 noindex를 적용하세요.',
    ETC: '원본 게시물·템플릿에서 검출 문구와 관련 링크를 제거하고, 같은 경로의 재등록 원인을 확인하세요.'
  };
  const defaultEditValues = Object.freeze({
    title: '여기에 수정할 타이틀을 입력하세요',
    body: '여기에 수정할 내용을 입력하세요'
  });

  function getPlacement(cms) {
    const entry = placements[String(cms || '').toLowerCase()];
    return entry ? { label: entry[0] + ' 추정', text: entry[1] } : {
      label: 'CMS 미확인',
      text: '사이트 전체에 적용되는 공통 <head> 템플릿 또는 헤더 코드 삽입 기능에 넣으세요.'
    };
  }

  function getRemedy(technique) {
    return remedies[technique] || remedies.ETC;
  }

  function initialTarget(evidence) {
    return String(evidence || '').replace(/^외부 연결 URL:\s*/, '')
      .replace(/^\s*(?:\.{3}|…)+\s*/, '').replace(/\s*(?:\.{3}|…)+\s*$/, '').trim();
  }

  function literal(value) {
    return JSON.stringify(String(value || ''))
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  function createSnippet(finding, settings) {
    const target = String(settings.target_text || '').trim();
    const isLink = String(finding.evidence_text || '').startsWith('외부 연결 URL:');
    if (target.length < 4) return { code: '', error: '오염 원문 또는 차단할 링크를 4자 이상 입력해 주세요.' };
    if (!finding.location || !String(finding.location).trim()) return { code: '', error: '탐지 위치가 없어 코드를 만들 수 없습니다.' };
    let url;
    try { url = new URL(finding.url); } catch (err) { return { code: '', error: '탐지 URL이 올바르지 않습니다.' }; }
    if (!/^https?:$/.test(url.protocol)) return { code: '', error: 'HTTP 주소만 지원합니다.' };
    const compact = [
      '<script>\nvar fcmstitle=', literal(settings.clean_title), ';\nvar fcmsdesc=', literal(settings.clean_body), ';\n',
      '(function(){var u=new URL(', literal(url.href), '),s=', literal(finding.location), ',q=', literal(target), ',link=', isLink ? 'true' : 'false', ';',
      'function z(x){return Array.from(new URLSearchParams(x)).sort(function(a,b){return a[0].localeCompare(b[0])||a[1].localeCompare(b[1])}).map(function(a){return encodeURIComponent(a[0])+"="+encodeURIComponent(a[1])}).join("&")}',
      'if(location.origin!==u.origin||location.pathname!==u.pathname||z(location.search)!==z(u.search))return;',
      'function run(){var d=document,part=s.split(" >>> "),nodes=[],hit=null,count=0,i,w,n,p,a,h,t,r,match;',
      'try{for(i=0;i<part.length-1;i++){p=d.querySelector(part[i]);if(!p||!p.contentDocument)return false;d=p.contentDocument}',
      'nodes=d.querySelectorAll(part[part.length-1])}catch(e){return false}',
      'if(link){var links=new Set();for(i=0;i<nodes.length;i++){if(nodes[i].matches("a"))links.add(nodes[i]);nodes[i].querySelectorAll("a").forEach(function(x){links.add(x)})}links.forEach(function(x){if(x.getAttribute("href")===q||x.href===q){count++;hit=x}})}',
      'else{r=new RegExp(q.split(/\\s+/).map(function(x){return x.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")}).join("\\\\s+"),"g");',
      'for(i=0;i<nodes.length;i++){w=d.createTreeWalker(nodes[i],4);while(n=w.nextNode()){r.lastIndex=0;while(match=r.exec(n.nodeValue)){count++;hit={n:n,p:match.index,v:match[0]};if(!match[0].length)break}}}}',
      'if(count!==1)return false;',
      'if(link){if(fcmsdesc)hit.replaceWith(d.createTextNode(fcmsdesc));else hit.remove()}',
      'else{n=hit.n;a=n.parentElement&&n.parentElement.closest("a");n.nodeValue=n.nodeValue.slice(0,hit.p)+fcmsdesc+n.nodeValue.slice(hit.p+hit.v.length);if(a)a.removeAttribute("href")}',
      'h=d.head;if(!h)return true;',
      'if(fcmstitle)d.title=fcmstitle;else if(d.title.includes(q))d.title=d.title.replace(q,"");',
      'function m(k,v,key){var e=h.querySelector("meta["+k+"=\\\""+v+"\\\"]");if(!e&&key){e=d.createElement("meta");e.setAttribute(k,v);h.appendChild(e)}if(e){t=e.content||"";if(key)e.content=key;else if(t.includes(q))e.content=t.replace(q,"")}}',
      'm("name","description",fcmsdesc);m("property","og:title",fcmstitle);m("property","og:description",fcmsdesc);m("name","twitter:title",fcmstitle);m("name","twitter:description",fcmsdesc);return true}',
      'function start(){if(run())return;var o=new MutationObserver(function(){if(run())o.disconnect()});o.observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){o.disconnect()},30000)}',
      'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start()',
      '})();\n</script>'
    ].join('');
    return { code: compact, error: '' };
  }

  return { createSnippet, getPlacement, getRemedy, initialTarget, defaultEditValues };
});
