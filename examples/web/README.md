# Web Example

`examples/web`는 브라우저에서 직접 provider와 RLM을 실행하는 React 단일 페이지 앱 예제입니다.

현재 구현은 다음을 포함합니다.

- OpenAI, Ollama Local, Ollama Cloud 중 하나를 브라우저에서 선택
- provider별 모델 목록 조회 후 `root` / `sub` 모델 선택
- 설정과 대화 turn을 IndexedDB에 저장
- 새 사용자 프롬프트 실행 시 이전 대화 전체를 RLM `context`로 전달
- `server.ts`를 통한 정적 파일 서빙

## 실행

```bash
cd examples/web
deno task dev
```

프로덕션 빌드와 정적 서빙은 다음 명령으로 실행합니다.

```bash
cd examples/web
deno task build
deno task serve
```

기본 정적 서버 주소는 `http://127.0.0.1:4173`입니다.
