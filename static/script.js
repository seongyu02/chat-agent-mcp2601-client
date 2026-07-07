
// 🟦 마크다운 렌더러 설정
// 클라이언트 측 자바스크립트의 첫 부분입니다. 이 코드는 marked.js 라이브러리를 설정하여 
// 채팅 메시지에 포함된 링크가 더 나은 사용자 경험을 위해 새 브라우저 탭에서 열리도록 합니다.

const renderer = {

  // link(href, title, text)는 마크다운의 [text](href "title") 문법을 만났을 때 호출됩니다.
  // href: 링크 주소, title: 툴팁으로 쓰일 제목(optional), text: 화면에 표시될 링크 텍스트  
  link(href, title, text) {
    // marked.js의 기본 링크 렌더러를 호출합니다.
    // prototype.link.call(this, ...)로 원본 로직을 그대로 실행시켜
    // 기본 <a href="..." title="...">text</a> 형태의 HTML 문자열을 얻습니다.
    const link = marked.Renderer.prototype.link.call(this, href, title, text);

    // 생성된 <a> 태그에 target="_blank"와 rel="noreferrer"를 추가합니다.
    // target="_blank": 링크를 새 탭에서 열어 현재 채팅 화면이 유지되도록 함
    // rel="noreferrer": 새 탭에 window.opener가 전달되지 않도록 하여
    //                    reverse tabnabbing 등의 보안 위험을 차단
    // <a 문자열 바로 뒤에 속성을 삽입하는 단순 문자열 치환 방식입니다.    
    return link.replace("<a", "<a target='_blank' rel='noreferrer' ")
  }
};

marked.use({renderer});


// 🟦 고유한 세션 ID 생성
const generateSessionId = () => {

  const timestamp = Date.now();

  // Math.random(): 0 이상 1 미만의 난수를 생성합니다.
  // .toString(36): 숫자를 36진법(0-9, a-z) 문자열로 변환하여 "0.xxxxx" 형태의 결과를 얻습니다.
  // .substring(2, 9): 앞의 "0." 부분을 잘라내고, 그 뒤 7자리 정도의 랜덤 문자열만 취합니다.
  // 같은 타임스탬프에 여러 세션이 생성되더라도 충돌하지 않도록 무작위성을 더하는 역할입니다.
  const randomString = Math.random().toString(36).substring(2, 9);

  // 템플릿 리터럴로 "session_<타임스탬프>_<랜덤문자열>" 형태의 최종 ID를 조합합니다.
  // 예: "session_1735689600000_a1b2c3d"
  return `session_${timestamp}_${randomString}`;
}

// 🟦 ChatApp 모듈: 초기화 및 이벤트 처리
// 이 코드는 채팅 애플리케이션의 핵심 로직을 담고 있는 ChatApp 모듈을 정의합니다

/**
 * 채팅 애플리케이션을 관리하는 모듈
 * 객체 리터럴 방식의 모듈 패턴으로, class 대신 하나의 객체 안에
 * 상태(elements, sessionId)와 동작(메서드)을 함께 묶어 관리합니다.
 * 별도의 인스턴스를 생성하지 않고 ChatApp 자체를 싱글턴처럼 사용합니다.
 */
const ChatApp = {

  // DOM 요소들을 저장할 객체
  // init() 실행 전에는 모두 null이며, init() 시점에 실제 DOM 노드로 채워집니다.
  elements: {
    chatForm: null,
    chatInput: null,
    chatBox: null,
  },

  // 세션 ID
  // 이 클라이언트(브라우저 탭)가 서버와 나누는 대화를 식별하는 고유 값입니다.
  // 서버는 이 값으로 대화 기록(히스토리)을 세션별로 구분해 관리합니다.  
  sessionId: null,

  // 🟡 앱을 초기화
  init() {
    // DOM 요소들을 찾아서 저장.
    this.elements.chatForm = document.getElementById('chat-form');
    this.elements.chatInput = document.getElementById('chat-input');
    this.elements.chatBox = document.getElementById('chat-box');

    // 세션 ID를 생성하고 로그에 기록합니다.
    // 페이지가 로드될 때마다(새로고침 포함) 새로운 세션 ID가 발급됩니다.
    this.sessionId = generateSessionId();
    console.log("🟠 새로운 세션 ID:", this.sessionId);

    // "submit" 이벤트는 사용자가 입력창에서 Enter를 누르거나
    // 전송 버튼을 클릭해 폼을 제출할 때 발생합니다.
    this.elements.chatForm.addEventListener(
      "submit",

      this.handleFormSubmit.bind(this)
    );
    
  }, // end init()

  // 🟡 채팅 폼 제출 이벤트 처리
  async handleFormSubmit(e) {
    e.preventDefault();   // 폼의 기본 제출동작을 막음.

    // 입력 창의 값을 읽기
    const message = this.elements.chatInput.value.trim();

    // 아무것도 입력안되어 있으면 리턴
    if(!message) return;

    // 사용자 메시지를 화면에 추가
    this.appendMessage("user", message);

    // 메시지 전송 후 입력창을 비우기
    this.elements.chatInput.value = "";

    // 챗봇의 응답을 스트리밍
    const botMessageElement = this.createMessageElement("bot");
    await this.streamBotResponse(message, botMessageElement);

  },  // end handleFormSubmit()


  // 🟡 서버로부터 챗봇의 응답을 스트리밍
  async streamBotResponse(message, botMessageElement) {
    try {
      // throw new Error("!!에러 테스트 발생!!");

      // fetch() 로 백엔드 /chat  엔드포인트에 POST 요청
      const response = await fetch("/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          message: message,
          session_id: this.sessionId,
        }),
      });

      // 응답의 HTTP 상태코드가 200 이 아니면 에러처리
      if(!response.ok){
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 응답(response)로 부터 스트림을 읽을수 있는 reader 객체 얻기
      const reader = response.body.getReader(); // 서버는 SSE 스트리밍으로 응답중입니다.

      // 문자열 디코딩 준비
      // 서버에서 오는 데이터는 바이트(Uint8Array)이므로, 이를 문자열로 디코딩할 TextDecoder를 준비합니다.
      const decoder = new TextDecoder();

      // 지금까지 수신하여 누적된 전체 텍스트(마크다운 원문)를 저장할 변수입니다.
      let content = "";

      // 스트림을 순차적으로 읽어서 화면에 점진적으로 표시
      // 무한 루프를 돌며 reader.read()로 청크를 하나씩 꺼내고,
      // 서버가 스트림을 종료하면(done === true) 반복을 빠져나갑니다.      

      while(true){
        // value: 이번에 수신한 청크(Uint8Array), done: 스트림 종료 여부
        const { value, done } = await reader.read();
        if(done) break;  // 스트림 종료 시 루프 탈출

        // 이번 청크를 문자열로 디코딩하여 누적 콘텐츠에 이어 붙입니다.
        // { stream: true } 옵션은 멀티바이트 문자(예: 한글)가 청크 경계에서
        // 잘리는 경우에도 다음 청크와 합쳐 올바르게 디코딩되도록 해 줍니다.
        content += decoder.decode(value, { stream: true });

        // 누적된 전체 마크다운 텍스트를 매 청크마다 다시 HTML로 파싱하여
        // 봇 메시지 요소에 통째로 반영합니다. (부분 마크다운도 자연스럽게 갱신됨)
        botMessageElement.innerHTML = marked.parse(content);
        
        // 스크롤을 맨 아래로 내립니다.
        this.scrollToBottom();

      } // end while

      
    } catch(error) {
      // 네트워크 오류, http 오류... 스트림 읽기중 오류...
      console.log("💥스트리밍 중 오류 발생:", error);
      botMessageElement.innerHTML = "💥죄송합니다. 메시지를 처리하는 중 오류가 발생했습니다";
    }
  },  // end streamBotResponse()

  // 🟡  새로운 메시지 요소를 생성하고 DOM 에 추가
  createMessageElement(sender) {
    // <div> 요소 생성
    const messageElement = document.createElement('div');

    // 공통 클래스 "message"와, 보낸 사람에 따라 "user-message" 또는 "bot-message"를
    // 함께 부여하여 CSS에서 발신자별로 다른 스타일(정렬, 배경색 등)을 적용할 수 있게 합니다.    
    messageElement.classList.add("message", `${sender}-message`);

    // 위 생성한 요소를 채팅박스 마지막 자식으로 추가 -> 화면에 표시됨!
    this.elements.chatBox.appendChild(messageElement);

    // 새 요소가 추가된 직후 스크롤 내리기
    this.scrollToBottom();

    return messageElement;  // 호출한 측에서 이 요소에 내용을 채워 넣을수 있도록 리턴

  }, // end createMessageElement()

  // 🟡 메시지를 화면에 추가
  appendMessage(sender, text) {
    // 발신자(sender) 에 맞는 빈 메시지 박스 생성
    const messageElement = this.createMessageElement(sender);
    // 메시지 박스에 HTML 로 변환하여 text 를 렌더링
    messageElement.innerHTML = marked.parse(text)

  }, // end appendMessage()

  // 🟡 채팅 박스를 맨 아래로 스크롤
  scrollToBottom() {
    this.elements.chatBox.scrollTop = this.elements.chatBox.scrollHeight;
  }, // end scrollToBottom()
  
} // end ChatApp

// DOM이 로드되면 애플리케이션을 초기화합니다.
// DOMContentLoaded 이벤트를 사용하여 DOM이 완전히 로드된 후에 ChatApp을 초기화합니다. 
// 이렇게 하면 모든 DOM 요소가 준비된 상태에서 애플리케이션이 시작됩니다.
document.addEventListener("DOMContentLoaded", () => {
  ChatApp.init();
});