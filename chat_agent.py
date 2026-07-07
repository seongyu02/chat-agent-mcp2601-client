# FastAPI 서버
from pathlib import Path
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn

# 랭체인, 랭그래프
from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

# MCP 클라이언트 
from contextlib import asynccontextmanager
from langchain_mcp_adapters.tools import load_mcp_tools
from mcp import ClientSession
import httpx
from mcp.client.streamable_http import streamable_http_client

# 환경변수
from dotenv import load_dotenv
load_dotenv()

# 프롬프트 템플릿 생성
def create_prompt_template(tools) -> str:
    """에이전트를 위한 시스템 프롬프트(문자열)를 생성합니다."""
    tool_descriptions = "\n".join(f"- {t.name}: {t.description}" for t in tools)

    system_prompt = f"""
당신은 친절하고 도움이 되는 AI 어시스턴트 "금토깽"입니다.

다음과 같은 도구들을 활용하여 사용자를 도와드릴 수 있습니다:

사용 가능한 도구:
{tool_descriptions}

사용자가 위치한 곳을 안다면 바로 brief_today() 도구의 지침을 따르면 됩니다. 아니라면, 위치를 물어보고나서 도구의 지침을 따릅니다.

사용자와의 대화에서 다음 원칙을 지켜주세요:
1. 항상 친절하고 정중한 태도로 응답해주세요
2. 사용자의 질문을 정확히 이해하고 관련된 도구를 적절히 활용해주세요
3. 최신 뉴스를 요청받으면, 도구의 출력을 그대로 출력하면 됩니다.
4. 응답은 명확하고 이해하기 쉽게 구성해주세요
5. 필요시 추가 정보나 설명을 제공하여 사용자에게 더 나은 도움을 주세요
6. 링크가 포함된 정보를 제공할 때는 [제목](URL) 형태의 마크다운 링크로 제공해주세요
"""
    return system_prompt

# 에이전트 생성
def build_agent_executor(tools):
    """주어진 도구를 사용하여 에이전트를 생성합니다."""
    memory = InMemorySaver()
    prompt = create_prompt_template(tools)
    llm = ChatOpenAI(model="gpt-4o")

    agent_executor = create_agent(
        model=llm,
        tools=tools,
        system_prompt=prompt,
        checkpointer=memory,
    )
    return agent_executor

# 에이전트 사용 준비
http_client = httpx.AsyncClient(timeout=30.0)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI 애플리케이션의 생명주기 동안 MCP 연결 및 에이전트 설정을 관리합니다."""
    print("🔵 애플리케이션 시작: MCP 서버에 연결하고 에이전트를 설정합니다...")

    # MCP_SERVER_URL 환경변수로 MCP 서버 주소를 설정합니다.
    # - 로컬 개발: 지정하지 않으면 기본값(http://localhost:8000/mcp) 사용
    # - Render 배포(production): https://chat-agent-mcp-server.fastmcp.app/mcp 로 설정
    mcp_server_url = os.getenv("MCP_SERVER_URL", "http://localhost:8000/mcp")

    async with streamable_http_client(
        url = "http://localhost:8000/mcp",
        http_client=http_client,
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await load_mcp_tools(session)

            # app.state 란?
            # FastAPI는 내부적으로 Starlette을 쓰는데, app.state는 그냥 빈 네임스페이스 객체.
            # 속성을 자유롭게 붙였다 뗐다 할 수 있는 컨테이너
            #  라우트 핸들러에서는 request.app.state.agent_executor로 어디서든 똑같은 객체에 접근할 수 있습니다.
            app.state.agent_executor = build_agent_executor(tools)
            print("🔵 에이전트 설정 완료. 애플리케이션이 준비되었습니다.")
            yield

    print("🔵 애플리케이션 종료.")
    app.state.agent_executor = None


app = FastAPI(lifespan=lifespan)

# chat_agent.py 파일의 위치를 기준으로 정적 파일 마운트
static_path = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=static_path), name="static")

# chat_agent.py 파일의 위치를 기준으로 templates 디렉토리의 절대 경로를 계산하여 설정
templates_path = Path(__file__).resolve().parent / "templates"
templates = Jinja2Templates(directory=templates_path)

# 메인 페이지 라우팅
@app.get("/")
async def read_root(request: Request):
    """메인 채팅 페이지 렌더링"""
    return templates.TemplateResponse(request, "index.html")

# 에이전트 응답 스트리밍 함수
async def stream_agent_response(agent_executor, message: str, session_id: str):
    """에이전트의 응답을 스트리밍하는 비동기 제너레이터"""
    if agent_executor is None:
        yield "💢에이전트가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요."
        return

    try:
        # config ={"configurable": { "thread_id": session_id}}는 채팅창에서 이전 대화를 기억할 수 있도록
        # session_id를 설정하는 코드입니다. session_id는 자바스크립트에서 생성된 값입니다.
        config = {"configurable": {"thread_id": session_id}}
        input_message = HumanMessage(content=message)

        # astream_events를 사용하여 응답 스트리밍
        # 응답을 스트리밍을 하기 위해 랭그래프의 astream_events() 함수를 사용하여
        # 에이전트의 처리 과정을 이벤트 단위로 받아 처리합니다.
        async for event in agent_executor.astream_events(
            {"messages": [input_message]},
            config=config,
            version="v2",
        ):
            """
            여기서 event는 이런 형태의 딕셔너리 (예시)

            {
                "event": "on_chat_model_stream",   # 이벤트 종류
                "name": "ChatOpenAI",              # 어떤 Runnable이 발생시켰는지
                "run_id": "...",                   # 이 실행의 고유 ID
                "parent_ids": [...],               # 상위 실행 체인 (v2부터 채워짐)
                "tags": [...],
                "metadata": {...},
                "data": {...},                     # 실제 내용물, 이벤트 종류마다 다름
            }
            """

            kind = event["event"]

            # on_chat_model_stream 이벤트 : LLM이 토큰을 한 조각씩 생성할 때마다 발생
            # 실제 텍스트 응답을 추출하여 클라이언트로 전송합니다.
            # event["data"]["chunk"] 는  AIMessageChunk 객체
            if kind == "on_chat_model_stream":
                print(f"🟨 chat_model_stream: content= ", end="")
                content = event['data']['chunk'].content
                print(content) # 확인용
                if content:
                    yield content # 스트리밍 받은 콘텐츠를 StreamingResponse를 통해 클라이언트로 전송된다.
            # on_tool_start / on_tool_end:
            #   모델이 tool_calls를 만들어서 tools 노드가 실행될 때 시작/종료 시점에 발생.
            #   event['name'] 에 도구 이름            
            # 구현을 간단하게 하기 위해 우리가 만드는 채팅 에이전트는 AI 모델의 메시지만 스트리밍으로 출력하겠습니다.
            elif kind == "on_tool_start":
                # TODO: 도구 사용 시작을 클라이언트에 알릴 수 있습니다.
                print(f"🟨 Tool start: {event['name']}")
            elif kind == "on_tool_end":
                # TODO: 도구 사용 완료를 클라이언트에 알릴 수 있습니다.
                print(f"🟨 Tool end: {event['name']}")
            else:
                # 그 외 on_chain_start, on_chain_end, on_chain_stream(그래프 노드 단위), on_llm_start 등
                # 훨씬 많은 이벤트가 존재하는데, 이번 예제에선 화면에 찍기만 합니다.
                print('🟨', event)
    
    except Exception as e:
        print(f"💢스트리밍 중 오류 발생: {e}")
        yield f"💢오류가 발생했습니다: {e}"


@app.post("/chat")
async def chat(request: Request, message: str = Form(...), session_id: str = Form(...)):
    """사용자 메시지를 받아 에이전트의 응답을 스트리밍 합니다"""
    agent_executor = request.app.state.agent_executor
    return StreamingResponse(
        stream_agent_response(agent_executor, message, session_id),
        media_type="text/event-stream", # SSE 방식으로 응답
    )

if __name__ == "__main__":
    # Render 등 PaaS는 PORT 환경변수로 사용할 포트를 지정합니다.
    # 로컬 개발 시에는 지정하지 않으면 기본값 8001 사용.
    port = int(os.getenv("PORT", 8001))

    uvicorn.run(app, 
                host="0.0.0.0",  # 127.0.0.1    localhost
                port=port,    # 현재  MCP server 가 port 8000 을 사용하기에 다른 port 사용
                )