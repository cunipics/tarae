function setCookie(name, value, expirehours){
	var todayDate = new Date();
	todayDate.setHours(todayDate.getHours() + expirehours);   //시간
	//todayDate.setDate(todayDate.getDate() + expirehours);   //날짜
	document.cookie = name + "=" + escape(value)+";path=/;expires="+todayDate.toGMTString()+";"
}

// 쿠키 가져오기 ##################################################
function getCookie(name) {
	var strArg = new String(name+"=");
	var nArgLen, nCookieLen, nEnd;
	var i = 0, j;

	nArgLen = strArg.length;
	nCookieLen = document.cookie.length;

	if (nCookieLen > 0) {
		while (i < nCookieLen) {
			j = i + nArgLen;
			if (document.cookie.substring(i, j) == strArg) {
				nEnd = document.cookie.indexOf (";", j);
				if (nEnd == -1) nEnd = document.cookie.length;
				return unescape(document.cookie.substring(j, nEnd));
			}

			i = document.cookie.indexOf(" ", i) + 1;
			if (i == 0) break;
		}
	}
	return("");
}
function deleteCookie(name) {
	document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}
if (navigator.userAgent.toLowerCase().indexOf('msie') != -1) {
	try { document.execCommand('BackgroundImageCache', false, true); } catch(e) {}
}

// Trim 함수 ##################################################
// Ex) str = "    테 스트   ".trim(); => str = "테 스트";
String.prototype.trim = function() {
	return this.replace(/(^[ \t\n\r]*)|([ \t\n\r]*$)/g,'');
}

// 문자열 공백제거 함수 ##################################################
// Ex) str = "    테 스   트   ".stripspace(); => str = "테스트";
String.prototype.stripspace = function() {
	return this.replace(/ /g, '');
}

// 전체 문자열 바꾸기 함수 ##################################################
// Ex) str = "a테스트bcd테스트efg".replaceAll("테스트", ""); => str = "abcdefg";
String.prototype.replaceAll = function(a, b) {
	var s = this;
	if (navigator.userAgent.toLowerCase().indexOf('msie') != -1)
		return s.replace(new RegExp(a, 'gi'), b);
	else
		return s.split(a).join(b);
}

String.prototype.toNumber = function() {
	var s = this;
	s = (typeof s == 'undefined' ? '0' : s.toString().replace(/,/g, ''));
	if (isNaN(s) || s.replace(/ /g, '') == '') return 0;
	else	return parseFloat(s);
}
String.prototype.insertSTag = function(b) {
	var s = this;
	var p = s.search(new RegExp(b, "i"));
	if(p>-1){
			return s.substr(0,p)+"<strong style='color:red;'>"+s.substr(p,b.length)+"</strong>"+s.substr(p+b.length);
	}
	return s;
}
// 팝업 ##################################################
function openPopup(theURL, winName, width, height, remFeatures) {
	var features = '';
	if (typeof winName == 'undefined') winName = '';
	if (typeof width != 'undefined') features += (features ? ',' : '')+'width='+width;
	if (typeof height != 'undefined') features += (features ? ',' : '')+'height='+height;
	if (typeof remFeatures != 'undefined') features += (features ? ',' : '')+remFeatures;
	if (features.indexOf('status') < 0) features += ',status=yes';

	var popup = window.open(theURL, winName, features);
	popup.focus();

	return popup;
}

// 팝업 - 팝업창 화면중앙 오픈 ##################################################
function openPopupCenter(theURL, winName, width, height, remFeatures) {
	var left = (screen.width/2) - (width/2);
	var top = (screen.availHeight/2) - (height/2);
	var features = 'left='+left+',top='+top+',width='+width+',height='+height;
	if (typeof winName == 'undefined') winName = '';
	if (typeof remFeatures != 'undefined') features += ','+remFeatures;
	if (features.indexOf('status') < 0) features += ',status=yes';

	var popup = window.open(theURL, winName, features);
	popup.focus();

	return popup;
}

// 팝업 - 팝업창 사이즈 조정 ##################################################
function resizePopupWindow(width, height) {
	var userAgent = navigator.userAgent.toLowerCase();
	var isMSIE = (userAgent.indexOf('msie') != -1);
	var agentVer = 0;
	if (isMSIE) {
		var pos_msie = userAgent.indexOf('msie ');
		agentVer = parseInt(userAgent.substring(pos_msie+5, userAgent.indexOf('.', pos_msie)), 10);
	}
	var isMoz = (userAgent.indexOf('gecko') != -1);
	var isChrome = (userAgent.indexOf('chrome') != -1);

	var resizeWidth = width + 10;
	var resizeHeight = height + ((isMSIE && agentVer>6) ? 71 : (isMoz ? (isChrome ? 55 : 81) : 49));

	window.resizeTo(resizeWidth, resizeHeight);

	if (!isChrome) {
		var lastHeight = resizeHeight - (parseInt(document.body.clientHeight, 10) - height);
		if (resizeHeight != lastHeight) { window.resizeTo(resizeWidth, lastHeight); }
	}
}

// 팝업 - 팝업창 위치 조정 ##################################################
function movePopupWindow(left, top) {
	window.moveTo(left, top);
}

// 페이지 이동 ##################################################
function gotoUrl(url) {
	if (url.stripspace() != '') {
		location.href = url;
	}
}

// 페이지 최상단으로 ##################################################
function goTop() {
	window.scrollTo(0, 0);
}





// 이미지 사이즈 줄이기 ##################################################
function resizeImage(img, limitId) {
	if (typeof (img) != 'object') img = document.getElementById(img);
	var imgWidth = parseInt(img.width, 10);
	var imgHeight = parseInt(img.height, 10);
	var fixWidth = imgWidth;

	img.setAttribute('orgWidth', imgWidth);
	img.setAttribute('orgHeight', imgHeight);

	if (typeof limitId == 'undefined') return;

	var parent = img.parentNode;
	while (parent) {
		if (parent.id == limitId) {
			fixWidth = parent.clientWidth;
			break;
		}
		parent = parent.parentNode;
	}

	if (imgWidth > fixWidth) img.width = fixWidth;
}

function resizeImageAll(limitId) {
	var limit = document.getElementById(limitId);
	if (limit) {
		var fixWidth = limit.clientWidth;
		var imgs = limit.getElementsByTagName('img');

		for (var i=0; i<imgs.length; i++) {
			imgs[i].setAttribute('orgWidth', parseInt(imgs[i].width, 10));
			imgs[i].setAttribute('orgHeight', parseInt(imgs[i].height, 10));
			if (parseInt(imgs[i].width, 10) > fixWidth) {
				imgs[i].width = fixWidth;
			}
		}
	}
}

// IFRAME RESIZE 함수 ##################################################
function resizeFrame(frameWindow, params) {
	if (!frameWindow.name) return false;

	var frameElement = document.getElementById(frameWindow.name);

	var frameDoc = null;
	if (frameElement.contentDocument) frameDoc = frameElement.contentDocument;
	else if (frameElement.contentWindow) frameDoc = frameElement.contentWindow.document;
	else frameDoc = frameElement.document;

	if (frameElement.style.display == 'none') frameElement.style.display = '';

	var frameBody = (frameDoc.documentElement || frameDoc.body);

	var resizeWidth = frameBody.scrollWidth;
	var resizeHeight = frameBody.scrollHeight;

	var minWidth = minHeight = 0;
	var maxWidth = maxHeight = 0;
	var fixWidth = fixHeight = 0;

	if (params) {
		if (params.wrap) {
			resizeWidth = params.wrap.offsetWidth;
			resizeHeight = params.wrap.offsetHeight;
		}

		minWidth = (params.minWidth ? parseInt(params.minWidth, 10) : 0);
		minHeight = (params.minHeight ? parseInt(params.minHeight, 10) : 0);
		maxWidth = (params.maxWidth ? parseInt(params.maxWidth, 10) : 0);
		maxHeight = (params.maxHeight ? parseInt(params.maxHeight, 10) : 0);
		fixWidth = (params.fixWidth ? parseInt(params.fixWidth, 10) : 0);
		fixHeight = (params.fixHeight ? parseInt(params.fixHeight, 10) : 0);
	}

	if (minWidth > 0 && resizeWidth < minWidth) resizeWidth = minWidth;			// 최소 폭
	if (minHeight > 0 && resizeHeight < minHeight) resizeHeight = minHeight;		// 최소 높이
	if (maxWidth > 0 && resizeWidth > maxWidth) resizeWidth = maxWidth;			// 최소 폭
	if (maxHeight > 0 && resizeHeight > maxHeight) resizeHeight = maxHeight;		// 최소 높이

	if (fixWidth > 0) resizeWidth = fixWidth;		// 고정 폭
	if (fixHeight > 0) resizeHeight = fixHeight;	// 고정 높이

	if (fixWidth > -1) frameElement.style.width = resizeWidth + 'px';
	if (fixHeight > -1) frameElement.style.height = resizeHeight + 'px';
}





// 공백 확인 ##################################################
function isEmpty(v) {
	return (v.trim()=='' ? true : false);
}

// 배열 확인 ##################################################
function isArray(obj) {
	try {
		return /^\s?function Array()/.test(obj.constructor.toString());
	}
	catch(e) {
		return false;
	}
}

// 숫자 확인 ##################################################
function isNumeric(value) {
	var compare = value;
	if (isNaN(compare) || value.replace(/ /g, '') == '') compare = '0';
	return (value==compare ? true : false);
}

function isN(str) {
	if(typeof str=="undefined")			return false;
	else if(str=="" || str==null)		return false;
	else								return str.toString().trim();
}
function setFloor(num, p) {
	if (!p) p = 0;
	return Math.floor(num * Math.pow(10, p)) / Math.pow(10, p);
}
// 날자 확인 ################################################## checkDate
function isDate(value){
	if (value.length != 10) return false;

	var arr = value.split('-');
	if (arr.length != 3 ) return false;

	var year = arr[0];
	var month = arr[1];
	var day = arr[2];
	var date = new Date(year+'/'+month+'/'+day+' 8:0:0');

	if (isNaN(date)) return false;

	return ((date.getFullYear().toString() == year) && (date.getMonth() == parseInt(month, 10) - 1) && (date.getDate() == parseInt(day, 10)) ? true : false);
}

// 영문 포함 확인 ##################################################
function isExistEng(value) {
	return /[a-zA-Z]/.test(value);
}

// 숫자 포함 확인 ##################################################
function isExistNum(value) {
	return /[0-9]/.test(value);
}

// 한글 포함 확인 ##################################################
function isExistKor(value) {
	return /[ㄱ-ㅎ가-힣]/.test(value);
}

// TEXT TO TAG ##################################################
function text2Tag(value) {
	return value.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}


// 체크박스 전체선택 ##################################################
function checkCbAll(cbList, isChecked) {
	obj = $("input[name="+cbList+"]");
	if (cbList) {
		if (typeof(obj.length) == 'undefined') {
			//if (!cbList.disabled) 
			obj.checked = isChecked;
		}
		else {
			for (var i=0; i<obj.length; i++) {
					//if (cbList[i].value.stripspace() != '' && !cbList[i].disabled) {
						obj[i].checked = isChecked;
					//}
			}
		}
	}
}

// 영문 확인 ##################################################
function checkEng(value) {
	return (isExistEng(value) ? true : false);
}


// 영문/숫자 혼용 확인 ##################################################
function checkMixEngNum(value) {
	return (isExistEng(value) && isExistNum(value) ? true : false);
}

// 특수문자 확인 ##################################################
function checkSpecialChar(value) {
	var schr = '`~!@#$%^&*_+=|\\[]{}:;,<.>/?\'"';
	for (var i=0; i<schr.length; i++) {
		if (value.indexOf(schr.substr(i, 1)) != -1) return true;
	}
	return false;
}

// 텍스트 길이 확인 (일반) ##################################################
function checkTextLen(obj, limit) {
	if (obj.value.length > limit){
		alert('1~'+limit+'자까지 입력이 가능합니다.');
		obj.value = obj.value.substring(0, limit);
		obj.focus();
		return false;
	}
	return true;
}

// 텍스트 길이 확인 (Byte) ##################################################
function checkTextLenByte(obj, limit) {
	var bytes = 0;
	var value = obj.value;

	for (var i=0; i<value.length; i++) {
		++bytes;
		if ((value.charCodeAt(i) < 0) || (value.charCodeAt(i) > 127)) ++bytes;

		if (bytes > limit) {
			alert('1~'+(limit / 2)+'자의 한글, 또는 2~'+limit+'자의 영문, 숫자, 문장기호로 입력이 가능합니다.');
			obj.value = value.substring(0, i);
			obj.focus();
			return false;
		}
	}
	return true;
}

// 텍스트 Byte 길이 가져오기 ##################################################
function getTextByte(value) {
	var bytes = 0;

	for (var i=0; i<value.length; i++) {
		if (escape(value.charAt(i)).length >= 4) {
			bytes += 2;
		}
		else if (escape(value.charAt(i)) != '%0D') {
			++bytes;
		}
	}

	return bytes;
}

// 파일명 확인 ##################################################
function checkFileName(obj) {
	var result = false;

	if (obj.value.stripspace() != '') {
		var fidx = obj.value.lastIndexOf('\\')+1;
		var filename = obj.value.substr(fidx, obj.value.length);
		result = isExistKor(filename);
	}

	if (result) {
		alert('파일명을 반드시 영문 또는 숫자로 해주세요.');
		obj.focus();
		return false;
	}
	return true;
}

// 파일 확장자 ##################################################
function getFileExt(value) {
	if (value != '') {
		var fidx = value.lastIndexOf('\\')+1;
		var filename = value.substr(fidx, value.length);
		var eidx = filename.lastIndexOf('.')+1;

		return filename.substr(eidx, filename.length);
	}
}
// 파일명 ##################################################
function basename(value) {
	if (value != '') {
		var fidx = value.lastIndexOf('/')+1;
		var filename = value.substr(fidx, value.length);
		return filename;
	}
}
// 파일확장자 확인 ##################################################
function checkImgFileExt(f) {
	var exts='gif,png,jpg,jpeg,bmp,tif,svg,';
	var arrExt = exts.toLowerCase().split(',');
	var result = false;

	if (f.stripspace() != '') {
		var ext = getFileExt(f).toLowerCase();

		for (var i=0; i<arrExt.length; i++) {
			if (arrExt[i].trim() == ext) result = true;
		}
	}

	if (!result) {
		alert('이미지파일만 업로드 가능합니다.');
		return false;
	}
	return true;
}
// 파일확장자 확인 ##################################################
function checkFileExt(f, exts, errMsg) {
	var arrExt = exts.toLowerCase().split(',');
	var result = false;

	if (f.stripspace() != '') {
		var ext = getFileExt(f).toLowerCase();

		for (var i=0; i<arrExt.length; i++) {
			if (arrExt[i].trim() == ext) result = true;
		}
	}

	if (!result) {
		alert(errMsg);
		return false;
	}
	return true;
}





// 내림 ##################################################
// num: 대상 숫자, p: 대상 자리수
function setFloor(num, p) {
	if (!p) p = 0;
	return Math.floor(num * Math.pow(10, p)) / Math.pow(10, p);
}

// 반올림 ##################################################
// num: 대상 숫자, p: 대상 자리수
function setRound(num, p) {
	if (!p) p = 0;
	return Math.round(num * Math.pow(10, p)) / Math.pow(10, p);
}

// 올림 ##################################################
// num: 대상 숫자, p: 대상 자리수
function setCeil(num, p) {
	if (!p) p = 0;
	return Math.ceil(num * Math.pow(10, p)) / Math.pow(10, p);
}

// 숫자 문자열에서 문자열 제거 ##################################################
function stripCharFromNum(value, dec) {
	var result = '';
	for (var i=0; i<value.length; i++) {
		var chr = value.charAt(i);
		switch (chr) {
			case '-':
				if (i == 0) result += '-';
			break;
			case '.':
				if (dec && result.indexOf('.') < 0) result += '.';
			break;
			default:
				if ('1234567890'.indexOf(chr) > -1) result += chr;
		}
	}
	return result;
}

// 콤마(,) 제거 ##################################################
function stripComma(num) {
    return num.replace(/,/g, '');
}
// 콤마(,) 제거 ##################################################
function delComma(obj) {
    obj.value=stripComma(obj.value);
}
// 숫자 3자리수마다 콤마(,) 찍기 ##################################################
function formatComma(num, p) {
	if (!p) p = 0;  //소숫점 이하 자리수
	var re = /(-?\d+)(\d{3}[,.])/;

	var nums = num.split('.');
	nums[0] += '.';

    while (re.test(nums[0])) {
        nums[0] = nums[0].replace(re, '$1,$2');
    }

	if (nums.length > 1) {
		if (nums[1].length > p) {
			nums[1] = nums[1].substr(0, p);
		}
		return nums.join('');
	}
	else return nums[0].split('.')[0];
}

// 강제 소수점 이하 0채우기 ##################################################
// num: 대상 숫자, p: 출력을 원하는 소수점자리수
function setRoundZero(num, p) {
	var nums = stripComma(num.toString()).split('.');

	if (nums.length <= 1) {
		num = nums[0]+'.';
		for (var i=0; i<p; i++) {
			num += '0';
		}
	}
	else num = setRound(num, p);

	return num;
}

// 소수점 이하 자리수 확인 ##################################################
// num: 대상 숫자, p: 희망 소수점 이하자리수
function checkRound(num, p) {
	var nums = num.toString().toNumeric().toString().split('.');
	if (nums.length > 1 && nums[1].length > p) return false;
	else return true;
}

function cutText(obj,len) {
	var s = $(obj).val();
	var size = 0;
	var rIndex = s.length;
		for ( var i = 0; i < s.length; i++) {
			if (escape(s.charAt(i)).length >= 4)	size += 2;
			else if (escape(s.charAt(i)) != '%0D') 	size++; 			
			if( size == len ) {
				rIndex = i + 1;
				break;
			} else if( size > len ) {
				rIndex = i;
				break;
			}
		}
	$(obj).val(s.substring(0, rIndex));
}
function Left(str,pos){
	if(isEmpty(str) || str.length < pos) return str;
	return str.substring(0, pos);
}
function gotoLogin() {
	if(!confirm('로그인이 필요한 메뉴입니다. 로그인 페이지로 이동합니다.')) return;
	location.href = "/member/login.html?redirect="+escape(document.URL);
}
function gotoAdmLogin() {
	alert('로그인 페이지로 이동합니다.');
	location.href = "/admin/login.html";
}

function doLogout(){
	location.href = "/logout.do";
}
function doMLogout(){
	location.href = "/admin/logout.html";
}
function isMobile(hp){
	var rgEx = /^(?:(010-\d{4})|(01[1|6|7|8|9]-\d{3,4}))-(\d{4})$/;
	if ( !rgEx.test( hp ) ) return false;
	return true;
}

function delHyphen(hp){
	return hp.value=hp.value.replaceAll("-", "");
}
function phoneFormat(hp){
	

	hp = hp.replaceAll("-", "");
	var strDDD = ["02" , "031", "032", "033", "041", "042", "043", "051", "052", "053", "054", "055", "061", "062", "063", "064", "010", "011", "012", "013", "015","016", "017", "018", "019", "070"];
	if (hp.length < 9) 	return hp;
	else if (hp.substring(0,2) == strDDD[0]) {
		if(hp.length<10) 	hp = hp.substring(0,2) + '-' + hp.substring(2, 5)+ '-' + hp.substring(5, hp.length);
		else				hp = hp.substring(0,2) + '-' + hp.substring(2, 6)+ '-' + hp.substring(6, hp.length);
	} else {
		for(var i=1; i < strDDD.length; i++) {
			if (hp.substring(0,3) == strDDD[i]) {
				//016-222-2222
				if(hp.length<11){
					hp = hp.substring(0,3) + '-' + hp.substring(3, 6)+ '-' + hp.substring(6, hp.length);
					break;
				}
				//016-2222-2222
				else{
					hp = hp.substring(0,3) + '-' + hp.substring(3, 7)+ '-' + hp.substring(7, hp.length);
					break;
				}
			}
		}
	}
	return hp;
}

function phFormat(hpArea){
	
	var hp = isN(hpArea.value)
	if (hp==false)		return "";
	hp = hp.replaceAll("-", "");

	var strDDD = ["02" , "031", "032", "033", "041", "042", "043", "051", "052", "053", "054", "055", "061", "062", "063", "064", "010", "011", "012", "013", "015","016", "017", "018", "019", "070"];
	if (hp.length < 9) 	return hp;
	else if (hp.substring(0,2) == strDDD[0]) {
		if(hp.length<10) 	hp = hp.substring(0,2) + '-' + hp.substring(2, 5)+ '-' + hp.substring(5, hp.length);
		else				hp = hp.substring(0,2) + '-' + hp.substring(2, 6)+ '-' + hp.substring(6, hp.length);
	} else {
		for(var i=1; i < strDDD.length-1; i++) {
			if (hp.substring(0,3) == strDDD[i]) {
				//016-222-2222
				if(hp.length<11){
					hp = hp.substring(0,3) + '-' + hp.substring(3, 6)+ '-' + hp.substring(6, hp.length);
					break;
				}
				//016-2222-2222
				else{
					hp = hp.substring(0,3) + '-' + hp.substring(3, 7)+ '-' + hp.substring(7, hp.length);
					break;
				}
			}
		}
	}
	return hpArea.value = hp;
}
function checkBizID(bizID)  //사업자등록번호 체크 
{ 
			if(bizID=="") return false;
      bizID = bizID.toString().replaceAll("-","").trim();
      var checkID = new Array(1, 3, 7, 1, 3, 7, 1, 3, 5, 1); 
      var tmpBizID, i, chkSum=0, c2, remander; 
      bizID = bizID.replace(/-/gi,''); 
 
      for (i=0; i<=7; i++) chkSum += checkID[i] * bizID.charAt(i); 
      c2 = "0" + (checkID[8] * bizID.charAt(8)); 
      c2 = c2.substring(c2.length - 2, c2.length); 
      chkSum += Math.floor(c2.charAt(0)) + Math.floor(c2.charAt(1)); 
      remander = (10 - (chkSum % 10)) % 10 ; 
 
      if (Math.floor(bizID.charAt(9)) == remander) return true ; // OK! 
      return false; 
} 
function bizNoFmt(no){
	return no.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3');
}

function checkEmail(emailVal){
	var regExp = /^[0-9a-zA-Z]([-_.]?[0-9a-zA-Z])*@[0-9a-zA-Z]([-_.]?[0-9a-zA-Z])*.[a-zA-Z]{2,3}$/i;
  // 검증에 사용할 정규식 변수 regExp에 저장

  if (emailVal.match(regExp) != null) {
    return true;
  }
  else {
    return false;
  }
}
function isValidPass(value){
	if(!checkpassLen(value,8)){ alert('비밀번호는 최소 8자리 이상이여야 합니다.');return false;}
	if(disallowPass(value)){ alert("비밀번호에 허용되지 않는 특수문자(<, >, (, ), #, ', /, |)가 있습니다.");return false;}
	if(continuePass(value)){ alert('비밀번호에 4자리 이상 연속된 문자(예:abc)는 사용할 수 없습니다.');return false;}
		
	if(!checkMixEngNum(value)){ alert('비밀번호는 영문과 숫자를 포함하여야 합니다.');return false;}
	if(!checkSpecialChar(value)){ alert('비밀번호는 최소 1개이상의 특수문자를 포함하여야 합니다.');return false;}
	return true;
}
function isValidPassEn(value){
	if(!checkpassLen(value,8)){ alert('Please register a password consisting of a combination of special characters, numbers, and English letters, with a length of 8 to 12 characters.');return false;}
	if(disallowPass(value)){ alert("There are special characters (<, >, (, ), #, ', /, |) that are not allowed in the password.");return false;}
	if(continuePass(value)){ alert('You cannot use more than 4 consecutive characters (eg abc) in your password.');return false;}
		
	if(!checkMixEngNum(value)){ alert('Password must contain English letters and numbers.');return false;}
	if(!checkSpecialChar(value)){ alert('Password must contain at least one special character.');return false;}
	return true;
}
function checkpassLen(value,len){
	if(getTextByte(value)<len) return false;
	return true;
}

function disallowPass(v){
 var digits = "\`~!@$%^&*-=\\_+,.?;:\"[]{}0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
 j = 0;
  for(i=0; i<v.length; i++){
  if(digits.indexOf(v.charAt(i)) < 0){
   j = j+1;
  }
 }
 if(j > 0){
  return true;
 }
 return false;
}

function continuePass(value){
 	var intCnt1 = 0;
        var intCnt2 = 0;
        var temp0 = "";
        var temp1 = "";
        var temp2 = "";
        var temp3 = "";
 
        for (var i = 0; i < value.length-3; i++) {
            temp0 = value.charAt(i);
            temp1 = value.charAt(i + 1);
            temp2 = value.charAt(i + 2);
            temp3 = value.charAt(i + 3);
 
            if (temp0.charCodeAt(0) - temp1.charCodeAt(0) == 1
                    && temp1.charCodeAt(0) - temp2.charCodeAt(0) == 1
                    && temp2.charCodeAt(0) - temp3.charCodeAt(0) == 1) {
                intCnt1 = intCnt1 + 1;
            }
 
            if (temp0.charCodeAt(0) - temp1.charCodeAt(0) == -1
                    && temp1.charCodeAt(0) - temp2.charCodeAt(0) == -1
                    && temp2.charCodeAt(0) - temp3.charCodeAt(0) == -1) {
                intCnt2 = intCnt2 + 1;
            }
        }
 
        //console.log(intCnt1 > 0 || intCnt2 > 0);
        return (intCnt1 > 0 || intCnt2 > 0);
}


// 특수문자 확인 ##################################################
function checkSpecialChar(value) {
	var schr = '`~!@#$%^&*_+=|\\[]{}:;,<.>/?\'"';
	for (var i=0; i<schr.length; i++) {
		if (value.indexOf(schr.substr(i, 1)) != -1) return true;
	}
	return false;
}

// 텍스트 길이 확인 (일반) ##################################################
function checkTextLen(obj, limit) {
	if (obj.value.length > limit){
		alert('1~'+limit+'자까지 입력이 가능합니다.');
		obj.value = obj.value.substring(0, limit);
		obj.focus();
		return false;
	}
	return true;
}
var entities = {
  'amp': '&',
  'apos': '\'',
  '#x27': '\'',
  '#x2F': '/',
  '#39': '\'',
  '#47': '/',
  'lt': '<',
  'gt': '>',
  'nbsp': ' ',
  'quot': '"'
}

function decodeHTML(text) {
  return text.replace(/&([^;]+);/gm, function (match, entity) {
    return entities[entity] || match
  })
}
async function getIpInfo(){	

	/*var xhr = new XMLHttpRequest();
	//var url = 'http://apis.data.go.kr/B551505/whois/domain_name'; 
	var url = 'https://apis.data.go.kr/B551505/whois/ipas_country_code';
	var queryParams = '?' + encodeURIComponent('serviceKey') + '='+'tQUceiTqzF4pPMb44zykNfrJNNJeQKrdC7aaqvpMb3aLFbEBa5WfoiB70U683Qp%2BBcShKd5vtHvLt028ZLReUw%3D%3D'; 
	//queryParams += '&' + encodeURIComponent('query') + '=' + encodeURIComponent(userIP);
	queryParams += '&' + encodeURIComponent('answer') + '=' + encodeURIComponent('json'); 
	xhr.open('GET', url + queryParams);
	
	xhr.onreadystatechange = function () {
	    if (this.readyState == 4) {
	        //console.log('Status: '+this.status+'nHeaders: '+JSON.stringify(this.getAllResponseHeaders())+'nBody: '+this.responseText);			
			try{					
				var obj = jQuery.parseJSON(this.responseText);
				if(obj.response.result.result_code=='10000'){
					var cntry = obj.response.whois.countryCode;
					var language = navigator.languages && navigator.languages[0] || // Chrome / Firefox
					   navigator.language ||   // All browsers
					   navigator.userLanguage; // IE <= 10	
					//var cid = document.getElementById("LOG_CID").value;
					//var bid = document.getElementById("LOG_BID").value;
					
					var cid = $("#LOG_CID").length?$("#LOG_CID").val():"";
					var bid = $("#LOG_BID").length?$("#LOG_BID").val():"";
					var params='url='+window.location.pathname+window.location.search+'&lang='+language+'&country='+cntry+'&cid='+cid+'&bid='+bid;
					//console.log(params)	;					
					doLogUrl('/logAct.html',params);					   
				}	   
			}catch(e){}
	    }
	};

	xhr.send('');	
					
	*/
}	
$( document ).ready(function() { 
	getIpInfo();
	setKeyProp();
  $('.find_file .blind').change(function(){
    $(this).parents('.find_file').find('.upfile').val( this.files[0].name );
  });

  $('.find_file .upfile').click(function(){	
  	$(this).next(0).trigger('click');
  });		
});
function setKeyProp(){
	
	// 한글입력막기 스크립트
	$(".not-kor").keyup(function(e) { 
		/*console.log(e.keyCode);
		if (!(e.keyCode >=37 && e.keyCode<=40)) {
			var v = $(this).val();
			$(this).val(v.replace(/[^a-z0-9]/gi,''));
		}*/
		$(this).val( $(this).val().replace( /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '' ) );
	});   
	//숫자만
	$("[numberOnly],[moneyOnly]").on("keyup", function() {   $(this).val($(this).val().replace(/[^0-9]/g,""));	});
	$("[floatOnly]").on("keyup", function() {   $(this).val($(this).val().replace(/[^0-9+.]/g,""));	});
	$("[DateOnly]").on("keyup", function() { $(this).val($(this).val().replace(/[^0-9+-]/g,""));});
	$("[DateOnly]").on("blur", function(e) { 
		if($(this).val().indexOf("-")==-1){
			var str = $(this).val().replaceAll("-", "");
			if(getTextByte($(this).val())>=8){		
				var year = str.substring(0,4);
				var month = str.substring(4,6);
				var date = str.substring(6,8);
				$(this).val(year+"-"+month+"-"+date);
			}	
		}
	});
	$("[BizNoOnly]").on("keyup", function() { $(this).val($(this).val().replace(/[^0-9+-]/g,""));});
	$("[BizNoOnly]").on("focus",function(){ $(this).val($(this).val().replaceAll("-", ""));	});
	$("[BizNoOnly]").on("blur",function(){ 	$(this).val(bizNoFmt($(this).val()));});
	$("[TelNumber]").on("keyup", function() { $(this).val($(this).val().replace(/[^0-9+-]/g,""));});
	$("[TelNumber]").on("focus",function(){ $(this).val($(this).val().replaceAll("-", ""));	});
	$("[TelNumber]").on("blur",function(){ 	$(this).val(phoneFormat($(this).val()));});
	$("[moneyOnly]").on("focus",function(){	$(this).val($(this).val().replaceAll(",", ""));	});
	$("[moneyOnly]").on("blur",function(){	$(this).val(formatComma($(this).val()));	});	
	$("[maxlen]").on("blur", function(e) {	var len = $(this).attr("maxlen");	if(getTextByte($(this).val())>len) cutText($(this),len);});	
	$("[max]").on("blur", function(e) {	var len = $(this).attr("max");	if(getTextByte($(this).val())>len) cutText($(this),len);});	
}
var doCallUrl = function(szUrl,params,callback){
			$.ajax({
				    url: szUrl,
				    type: "POST",
				    data : params,
				    async: true,
				    beforeSend: function(xhr) {$.LoadingOverlay("show");  xhr.setRequestHeader("apikey", "ghksruddpsjwltpsxjwowlfrnwhrotjs");},
				    success: function(data){				    					    	
			        	if(isN(data)==false){alert(data);}
			        	//console.log(data);			        	
			        	try{	
			        		json =$.parseJSON(data); 
			        		if(json.error==100){ gotoLogin();return;} else if(json.error==200){ gotoAdmLogin();return;}
			        		else if (callback) {callback(json);} 
			        	}catch(e){$.LoadingOverlay("hide");alert(data.replace(/'/g, ''));}
				    },
				    complete:function(){$.LoadingOverlay("hide");},
				    error: function(xhr, ajaxOptions, thrownError) {
				    	$.LoadingOverlay("hide");alert("오류가 발생 하였습니다.\n"+xhr.responseText.replace(/'/g, ''));
				      //console.log(thrownError + "\r\n" + xhr.statusText + "\r\n" + xhr.responseText);
				    }
				});		
};
var doSendUrl = function(szUrl,params,callback){
			$.ajax({
				    url: szUrl,
				    type: "POST",
				    data : params,
				    async: true,
				    processData: false,
		    		contentType: false,
				    beforeSend: function(xhr) {$.LoadingOverlay("show");  xhr.setRequestHeader("apikey", "ghksruddpsjwltpsxjwowlfrnwhrotjs");},
				    success: function(data){				    					    	
			        	if(isN(data)==false){alert(data);}			        	
			        	try{	
			        		json =$.parseJSON(data); 			        		
			        		if(json.error==100){ gotoLogin();return;} else if(json.error==200){ gotoAdmLogin();return;}
			        		else if (callback) {callback(json);} 
			        	}catch(e){$.LoadingOverlay("hide");alert(data.replace(/'/g, ''));}
				    },
				    complete:function(){$.LoadingOverlay("hide");},
				    error: function(xhr, ajaxOptions, thrownError) {
				    	$.LoadingOverlay("hide");alert("오류가 발생 하였습니다.\n"+xhr.responseText.replace(/'/g, ''));
				      //console.log(thrownError + "\r\n" + xhr.statusText + "\r\n" + xhr.responseText);
				    }
				});		
};
var doSilentUrl = function(szUrl,params,callback){
			$.ajax({
				    url: szUrl,
				    type: "POST",
				    data : params,
				    async: true,
				    beforeSend: function(xhr) {xhr.setRequestHeader("apikey", "ghksruddpsjwltpsxjwowlfrnwhrotjs");},
				    success: function(data){				    					    	
			        	if(isN(data)==false){alert(data);}
			        	//console.log(data);			        	
			        	try{	
			        		json =$.parseJSON(data); 
			        		if(json.error==100){ gotoLogin();return;} else if(json.error==200){ gotoAdmLogin();return;}
							else if (callback) {callback(json);} 
			        	}catch(e){}
				    },
				    error: function(xhr, ajaxOptions, thrownError) {
				    	//alert("오류가 발생 하였습니다.\n"+xhr.responseText.replace(/'/g, ''));
				    }
				});		
};
var doLogUrl = function(szUrl,params){
			$.ajax({
				    url: szUrl,
				    type: "POST",
				    data : params,
				    async: true,
				    beforeSend: function(xhr) {xhr.setRequestHeader("apikey", "ghksruddpsjwltpsxjwowlfrnwhrotjs");},
				    success: function(data){},
				    error: function(xhr, ajaxOptions, thrownError) {}
				});		
};
var doSearchUrl = function(szUrl,params,callback){
			$.ajax({
				    url: szUrl,
				    type: "POST",
				    data : params,
				    async: true,
				    processData: false,
		    		contentType: false,					
				    beforeSend: function(xhr) {$.LoadingOverlay("show");xhr.setRequestHeader("ApiKey", "ghksruddpsjwltpsxjwowlfrnwhrotjs");},
				    success: function(data){
						
			        	if(isN(data)==false){return;}      	
			        	try{						
							json =$.parseJSON(data); 							
			        		if(json.error==100){ gotoLogin();return;} else if(json.error==200){ gotoAdmLogin();return;}
			        		else if (callback) {callback(json);} 
						}catch(e){$.LoadingOverlay("hide");}
				    },
					complete:function(){$.LoadingOverlay("hide");},
				    error: function(xhr, ajaxOptions, thrownError) {
				    	$.LoadingOverlay("hide");alert("오류가 발생 하였습니다.\n"+xhr.responseText.replace(/'/g, ''));
				      //console.log(thrownError + "\r\n" + xhr.statusText + "\r\n" + xhr.responseText);
				    }
				});		
};

function sendSns(sns, url, txt)
{
    var o;
    var _url = encodeURIComponent(url);
    var _txt = encodeURIComponent(txt);
    var _br  = encodeURIComponent('\r\n');

    switch(sns)
    {
    	case 'blog':
    		o = {
                method:'popup',
                url:'http://blog.naver.com/openapi/share?url='+_url
    		};
    		break;
        case 'facebook':
            o = {
                method:'popup',
                url:'http://www.facebook.com/sharer/sharer.php?u=' + _url
            };
            break;

        case 'twitter':
            o = {
                method:'popup',
                url:'http://twitter.com/intent/tweet?text=' + _txt + '&url=' + _url
            };
            break;


        default:
            alert('지원하지 않는 SNS입니다.');
            return false;
    }

    switch(o.method)
    {
        case 'popup':
            window.open(o.url);
            break;

        case 'web2app':
            if(navigator.userAgent.match(/android/i))
            {
                // Android
                setTimeout(function(){ location.href = 'intent://' + o.param + '#Intent;' + o.g_proto + ';end'}, 100);
            }
            else if(navigator.userAgent.match(/(iphone)|(ipod)|(ipad)/i))
            {
                // Apple
                setTimeout(function(){ location.href = o.a_store; }, 200);
                setTimeout(function(){ location.href = o.a_proto + o.param }, 100);
            }
            else
            {
                alert('이 기능은 모바일에서만 사용할 수 있습니다.');
            }
            break;
    }
}