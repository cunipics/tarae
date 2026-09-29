$(document).ready(function () {

   /* datepicer */
   $('.cal').each(function () {
      var thisDatePicker = $(this);
      thisDatePicker.datepicker({
         dateFormat: 'yy-mm-dd',
         prevText: '이전 달',
         nextText: '다음 달',
         monthNames: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
         monthNamesShort: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
         dayNames: ['일', '월', '화', '수', '목', '금', '토'],
         dayNamesMin: ['일', '월', '화', '수', '목', '금', '토'],
         showMonthAfterYear: true,
         yearSuffix: '년 ',
         changeMonth: true,
         changeYear: true,
         yearRange: "1900:2050",
      });
   });

   /* 전체 선택 */
   $("#allChk").click(function () {
      if ($("#allChk").is(":checked")) {
         $(".chk").prop("checked", true);
      } else {
         $(".chk").prop("checked", false);
      }
   });

   $(".chk[name='chk']").click(function () {
      var chkLength = $('.chk[name="chk"]').length;
      if ($(".chk[name='chk']:checked").length == chkLength) {
         $("#allChk").prop("checked", true);
      } else {
         $("#allChk").prop("checked", false);
      }
   });


})
