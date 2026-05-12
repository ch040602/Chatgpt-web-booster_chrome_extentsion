# ChatGPT Long Chat Loader

긴 ChatGPT 대화의 브라우저 로딩과 RAM 부담을 줄이기 위한 Chrome MV3 확장입니다.

기본 README는 영어입니다. 한국어 문서는 이 파일이며, popup의 **한국어 README** 버튼으로 열 수 있습니다.

## v1.1.0 핵심 변경

v1.1.0은 속도 최적화보다 **현재 답변 진행상황 안정성**을 우선합니다.

### 수정/추가 사항

- **Thinking Shield**를 강화했습니다.
- thinking/reasoning/status 요소가 감지되면 최대 15분 동안 보호합니다.
- thinking/reasoning 중에는 conversation GET 응답을 trim/rewrite하지 않고 원본 그대로 통과시킵니다.
- 현재 thinking/reasoning turn에는 `display:none`, `aria-hidden`, `content-visibility:auto`, `contain-intrinsic-size`를 적용하지 않습니다.
- ChatGPT가 명확한 streaming marker를 노출하지 않아도 최신 대화 tail은 항상 live-protected 처리합니다.
- MAIN-world fetch patch가 conversation graph 안의 active thinking/reasoning node를 live generation으로 보고 trim을 우회합니다.
- 네트워크 안전 모드는 계속 기본값입니다. route별 초기 conversation 로딩 1회만 줄이고, 이후 refresh/recovery 요청은 원본으로 통과시킵니다.
- unusual/suspicious activity 문구 감지 시 passive safety lock은 유지됩니다.
- `content.js`는 `document_idle`에 실행되어 초기 DOM observer 부담을 낮췄고, MAIN-world fetch patch는 계속 `document_start`에 실행됩니다.

## 기본값

| 설정 | 기본값 |
|---|---:|
| 확장 사용 | 켜짐 |
| 초기 API 응답 줄이기 | 켜짐 |
| 네트워크 안전 모드 | 켜짐 |
| 처음 표시할 최근 턴 | 3 |
| 더 보기 배치 | 4 |
| API 사전 보관 배치 | 1 |
| response micro-cache | 1개 |
| cache 항목 상한 | 512 KB |
| 자동 정리 주기 | 45초 |
| 상태 배지 | 꺼짐 |

## popup 진단 항목

popup이 열려 있을 때만 추정치를 계산합니다.

- 예상 로딩 개선 정도
- API trim 메시지 수와 추정 크기 감소
- DOM 표시/숨김 개수
- 응답 진행 보호 상태
- Thinking Shield 상태
- live API 원본 통과 상태
- 보안 안전 잠금 상태
- micro-cache 상태
- content/main script 버전

## 설치

1. ZIP 압축을 풉니다.
2. `chrome://extensions`를 엽니다.
3. 개발자 모드를 켭니다.
4. **Load unpacked**를 누릅니다.
5. 압축 해제한 확장 폴더를 선택합니다.
6. 기존 ChatGPT 탭을 새로고침합니다.
7. popup에서 `API patch: MAIN 1.1.0`을 확인합니다.

## Unusual activity 경고 관련

이 확장은 OpenAI 보안 시스템을 우회하지 않습니다. ChatGPT에 unusual/suspicious activity 경고가 표시되면 safety lock 상태로 들어가 conversation response rewrite를 임시 중단합니다. VPN, proxy, 브라우저/기기 세션, 네트워크 평판, 계정 보안 상태도 확장과 무관하게 경고를 유발할 수 있습니다.

## 업데이트 helper

popup에 GitHub 업데이트 버튼이 있습니다. 저장소 주소는 내부 고정값을 사용하고, 별도 링크/입력란으로 표시하지 않습니다. Chrome unpacked extension은 스스로 파일을 교체할 수 없으므로, helper는 최신 ZIP 다운로드와 확장 관리 페이지 열기를 지원합니다.

## 한계

- 인증된 실제 긴 대화 E2E benchmark는 사용자 ChatGPT 세션에서 직접 확인해야 합니다.
- ChatGPT DOM/API가 바뀌면 selector 또는 trim 로직 수정이 필요할 수 있습니다.
- 서버 측 모델 context 자체를 줄이는 것은 아니며, 브라우저 로딩·렌더링·메모리 부담을 줄이는 확장입니다.
