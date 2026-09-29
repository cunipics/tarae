function httpError(status, message) {
  const err = new Error(message || 'Server Error');
  err.status = status || 500;
  return err;
}
function authCheck(groups,levels,ugroup,ulevel){
//console.log("====>"+levels);
 if(!groups.includes('G')){//'누구나' 권한이 없을 경우
    if(!ulevel){//로그인 안 했거나,
      if(groups.length==1 && groups.includes('P')){
        return false;//"회원사회원만 이용하실 수 있습니다."
      }else if(groups.length==1 && groups.includes('B')){
        return false;//"기업회원만 이용하실 수 있습니다."
      }else{
        return false;//"권한이 없습니다."
      }
    }
    if(!groups.includes(ugroup)){//해당 그룹이 아니면
      if(groups.length==1 && groups.includes('P')){
        return false;//"회원사회원만 이용하실 수 있습니다."
      }else if(groups.length==1 && groups.includes('B')){
        return false;//"기업회원만 이용하실 수 있습니다."
      }else{
        return false;//"권한이 없습니다."
      }
    }else{
      if(ugroup == "B" || ugroup == "P" || ugroup == "M"){
        if(levels > ulevel){
          return false;//"권한이 없습니다."
        }
      }
    }
  }
  return true;
}
function checkAdminSession(req, res, next) {
    const admin = req.session && req.session.authAdmin;
    if (!admin) {
      return res.redirect('/mgr/login');
    }
    res.locals.admin = admin;
    res.locals.authAdmin = admin;
    next();
};
function checkMemberSession(req, res, next) {
    const member = req.session && req.session.member;
    if (!member) {
      return res.redirect('/mgr/login');
    }
    next();
};
function loadSession(req, res, next) {
  const authMember = req.session && req.session.authMember ? req.session.authMember : null;
  res.locals.authMember = authMember;//ejs에서 바로 접근
  const authAdmin = req.session && req.session.authAdmin ? req.session.authAdmin : null;
  res.locals.authAdmin = authAdmin;//ejs에서 바로 접근
  next();
}
function datediff(start_date,end_date){
  var diff = 0;
  var aDay = 86400000;
  diff = Math.floor(
      (
          Date.parse(
              end_date.replace(/-/g, '\/')
          ) - Date.parse(
              start_date.replace(/-/g, '\/')
          )
      ) / aDay);
  return diff;
}
function getToday(){
  var date = new Date();
  var year = date.getFullYear();
  var month = ("0" + (1 + date.getMonth())).slice(-2);
  var day = ("0" + date.getDate()).slice(-2);
  return year + "-" + month + "-" + day;
}

function increaseThread(phrase)
{ var i,last,letters,words=phrase.split(/\s+/);
  for(i=0;i<words.length;i++)
  { letters=words[i].split('');
    last=letters.length-1;
    letters[last]=97<letters[last].charCodeAt(0)?String.fromCharCode(letters[last].charCodeAt(0)+1):'z';
    words[i]=letters.join('');
  }
  return words.join(' ');
}

//페이징
function setPageTable(map,viewRow){
  let m_PageNo = parseInt(map.pageno);
  let m_TotalRecord = parseInt(map.total);
  let m_LastPage =  parseInt(map.pages);
  let m_StartPage =  parseInt(map.startpage) ;
  let m_EndPage =  parseInt(map.endpage) ;
  let m_ViewRow=viewRow;
  let m_GetRow = 0;
  if (m_LastPage>0 && m_PageNo > m_LastPage){
    m_PageNo = m_LastPage;
  }
  if(m_PageNo === m_LastPage){
    m_GetRow = m_TotalRecord % m_ViewRow;
    if(m_GetRow === 0) m_GetRow = m_ViewRow;
  }else{
    let m_GetRow = m_ViewRow;
  }
  let Row=m_GetRow;
  let limit=(m_PageNo - 1)*m_ViewRow;

  map.m_TotalRecord = m_TotalRecord;
  map.m_PageNo = m_PageNo;
  map.m_StartPage = m_StartPage;
  map.m_LastPage = m_LastPage;
  map.m_EndPage= m_EndPage;
  map.limit = limit;
  return map;
}
function getPageTableA(map,callBack){//관리자 페이지 전용
  if (map.m_TotalRecord>0){
    let str = "<input type='hidden' id='pageNo'><script> function goPageNavi(no){if ($('#pageNo').length ) $('#pageNo').val(no); "+callBack+";}</script>";
    str+="<div class='paging'>";
    str+="<a href='javascript:void(0);' onclick='goPageNavi(1);' class='first'><i class='ico_commboard'>처음으로</i></a>";
    str+="<a href='javascript:void(0);' onclick='goPageNavi("+(map.m_PageNo-1)+");' class='prev'><i class='ico_commboard'>이전</i></a>";
    str+="<ul class='lst'>";
    for(var i=map.m_StartPage ; i<=map.m_EndPage;i++){
      if (i == map.m_PageNo ) {
        str += "<li class='on'><span class='blind'>현재</span><a href='javascript:void(0);' class='num'>" + i + "</a></li>";
      }else{
        str+="<li><span class='blind'></span><a href='javascript:void(0);' class='num' onClick='goPageNavi("+i+");'>"+i+"</a></li>";
      }
    }
    str+="</ul>";
    str+="<a href='javascript:void(0);' onClick='goPageNavi("+(map.m_PageNo+1)+");'class='next'><i class='ico_commboard'>다음</i></a>";
    str+="<a href='javascript:void(0);' onClick='goPageNavi("+(map.m_LastPage)+");'class='last'><i class='ico_commboard'>끝으로</i></a>";
    str+="</div>";
    return str;
  }
}
function getPageTableH(map,callBack){//홈페이지 전용
  if (map.m_TotalRecord>0){
    let str = "<input type='hidden' id='pageNo'><script> function goPageNavi(no){if ($('#pageNo').length ) $('#pageNo').val(no); "+callBack+";}</script>";
    str+="<div class='paging'>";
    str+="<a href='javascript:void(0);' onclick='goPageNavi(1);' class='first'><i class='ico_commboard'>처음으로</i></a>";
    str+="<a href='javascript:void(0);' onclick='goPageNavi("+(map.m_PageNo-1)+");' class='prev'><i class='ico_commboard'>이전</i></a>";
    str+="<ul class='lst_page'>";
    for(var i=map.m_StartPage ; i<=map.m_EndPage;i++){
      if (i == map.m_PageNo ) {
        str += "<li class='current'><span class='blind'>현재</span><a href='javascript:void(0);'>" + i + "</a></li>";
      }else{
        str+="<li><span class='blind'></span><a href='javascript:void(0);' onClick='goPageNavi("+i+");'>"+i+"</a></li>";
      }
    }
    str+="</ul>";
    str+="<a href='javascript:void(0);' onClick='goPageNavi("+(map.m_PageNo+1)+");'class='next'><i class='ico_commboard'>다음</i></a>";
    str+="<a href='javascript:void(0);' onClick='goPageNavi("+(map.m_LastPage)+");'class='last'><i class='ico_commboard'>끝으로</i></a>";
    str+="</div>";
    return str;
  }
}
module.exports = {
    httpError : httpError,
    authCheck : authCheck,
    loadSession : loadSession,
    datediff : datediff,
    getToday : getToday,
    checkMemberSession : checkMemberSession,
    checkAdminSession : checkAdminSession,
    increaseThread : increaseThread,
    getPageTableH : getPageTableH,
    getPageTableA : getPageTableA,
    setPageTable: setPageTable
};