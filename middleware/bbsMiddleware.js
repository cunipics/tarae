const commonDAO = require('../service/commonDAO');
const util = require('../utils/util');
const asyncReqHandler = require('../service/asyncReqHandler');

module.exports = asyncReqHandler(async function bbsMiddleware(req, res, next) {
  const content = res.locals.content;
  const bid = content.bid;
  const authMember = res.locals.authMember;
  let param = req.input;


  var rec = await commonDAO.selectOne("bbsMapper.selectBbsConf",{bid : bid});
  if (rec.count > 0) {
    let map = rec.row;
    const uLevel = authMember ? authMember.mLevel : 0;
    const uGroup = authMember ? authMember.mType : '';
    const ISPRIVATE=map.isprivate;
    const L_LEVEL=map.lLevel;
    const R_LEVEL=map.rLevel;
    const W_LEVEL=map.wLevel;
    const D_LEVEL=map.dLevel;
    const P_LEVEL=map.pLevel;
    const Y_LEVEL=map.yLevel;
    const L=map.l;
    const L_ARR = L.split("|");
    const R=map.r;
    const R_ARR = R.split("|");
    const W=map.w;
    const W_ARR = W.split("|");
    const D=map.d;
    const D_ARR = D.split("|");
    const P=map.p;
    const P_ARR = P.split("|");
    const Y=map.y;
    const Y_ARR = Y.split("|");

    //각 게시판별 접근 그룹 체크
    if(W_ARR.includes(uGroup) || W_ARR.includes('G')){
        param.wFlag = true;//글 쓰기 그룹
    }
    if(R_ARR.includes(uGroup) || R_ARR.includes('G')){
        param.rFlag = true;//글 읽기 그룹
    }
    if(D_ARR.includes(uGroup) || D_ARR.includes('G')){
        param.dFlag = true;//다운로드 그룹
    }
    if(P_ARR.includes(uGroup) || P_ARR.includes('G')){
        param.pFlag = true;//댓글쓰기 그룹
    }
    if(Y_ARR.includes(uGroup) || Y_ARR.includes('G')){
        param.yFlag = true;//답글쓰기 그룹
    }
    switch (req.input.role) {
      default://view
        if(!util.authCheck(L_ARR,L_LEVEL,uGroup,uLevel)){
            return next(Object.assign(new Error('조회 권한이 없습니다..'), { status: 403 }));
        }else{
            param.bid = bid;
            param.ViewRow=20;
            param.ViewPage=20;
            if(param.page && param.page!=="" && parseInt(param.page)>0) {
                param.pageNo=param.page;
            }else{
                param.pageNo=1;
            }
            const pagemap = await commonDAO.selectOne("bbsMapper.selectBbsList_PAGE",param);
            const setPage = util.setPageTable(pagemap.row,param.ViewRow);
            param.totalRecords = setPage.m_TotalRecord;
            param.limit = setPage.limit?setPage.limit:0;
            const list = await commonDAO.selectList("bbsMapper.selectBbsList",param);
            const listtop = await commonDAO.selectList("bbsMapper.selectBbsListtop",param);
            param.status = 1;//정상 카테고리만
            const bbscate = await commonDAO.selectList("bbsMapper.selectBbsCategoryList",param);
            const pagination = util.getPageTableH(setPage,"goPage()");
            //console.log("======>"+pagination);
            return res.render('bb/skin/' + map.skin + '/list.html', {list,listtop,pagination,param:param});
        }
        break;
      case "write":
      case "modify":
      case "reply":
        const filelist=rec= {};
        const B_UID = param.uid;
        const B_PID = param.pid;
        if(B_PID || B_UID){//수정 또는 답변
            if(!util.authCheck(W_ARR,W_LEVEL,uGroup,uLevel)){//조회 권한
                return next(Object.assign(new Error('접근 권한이 없습니다..'), { status: 403 }));
            }
            if(B_PID){
                //PID가 있으면 reply
                param.uid=param.parent;
            }
            param.onoff=1;//대기아닌 게시물
            param.status=1;//삭제되지 않은 게시물
            rec = await commonDAO.selectOne("bbsMapper.selectBbsRead",param);//reply이면 parant게시물
            if(rec.count > 0){
              const result = rec.row;
              const userid = result.userid;
              if(B_UID){
                  //UID가 있으면 modify
                  if(userid != req.session.authMember.mId){
                    return next(Object.assign(new Error('본인 글만 수정하실 수 있습니다.'), { status: 403 }));
                  }
                  param.pid=B_UID;
                  filelist = await commonDAO.selectList("bbsMapper.selectBbsFiles",param);
              }
            }
        }
        param.onoff=1;//대기아닌 게시물
        const bbscate = await commonDAO.selectList("bbsMapper.selectBbsCategoryList",param);
        return res.render('bb/skin/' + map.skin + '/write.html', {bbscate,map,result,filelist,param:param});
        break;
      case "read":
        if(!util.authCheck(R_ARR,R_LEVEL,uGroup,uLevel)){
            return next(Object.assign(new Error('접근 권한이 없습니다..'), { status: 403 }));
        }else{

            //조회 수 증가
            const trx = await commonDAO.beginTransaction();
            await commonDAO.insert("bbsMapper.updateBbsHits",param);
            await commonDAO.commit(trx);
            //1:1게시판(ISPRIVATE==1) 본인 확인
            if(ISPRIVATE == "1"){
                if(result.userid != req.session.authMember.mId && result.puserid != req.session.authMember.mId){
                    return next(Object.assign(new Error('본인 글만 확인하실 수 있습니다.'), { status: 403 }));
                }
            }
            //읽기 조회쿼리
            //param.uid 파라미터
            param.onoff=1;//대기아닌 게시물
            param.status=1;//삭제되지 않은 게시물
            rec = await commonDAO.selectOne("bbsMapper.selectBbsRead",param);
            if(rec.count > 0){
              result = rec.row;
              const nex = await commonDAO.selectOne("bbsMapper.selectBbsNext",param);
              const prv = await commonDAO.selectOne("bbsMapper.selectBbsPrev",param);

              //파일 리스트
              param.bid=result.bid;
              param.pid=param.uid;//파라미터
              const filelist = await commonDAO.selectList("bbsMapper.selectBbsFiles",param);	//첨부파일 있는경우

              //멘트 리스트
              param.puid=param.uid;//파라미터
              const mentlist = await commonDAO.selectOne("bbsMapper.selectBbsReplyList",param);
             
              res.render('bb/skin/' + map.skin + '/view.html', {cmap,result,filelist,mentlist,nex,prv,param:param});
            } 
          }
          break;
    }
    return next(Object.assign(new Error('콘텐츠 준비 중 입니다.'), { status: 403 }));

  }else{
    return next(Object.assign(new Error('콘텐츠를 찾을 수 없습니다.'), { status: 404 }));
  }
});
