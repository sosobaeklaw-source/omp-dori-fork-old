# 레드팀 도구

`redteam.py`는 산출물 하나를 여러 모델에 동시에 물어 약점만 모은다. 카본(Gemini 웹), 웹 GPT 6 Pro, 해적선 모델이 각각 한 가지다.

## 웹 GPT 6 Pro 실행기 계약

실행기는 `~/sobaegi-lead/results/gpt-web/run.js`에 있다. 아직 이 맥에는 없다. 없으면 그 가지는 '못 받음(runner missing)'으로 남고, 다른 모델로 대신하지 않는다.

`redteam.py`는 아래처럼 부른다. 잠금은 `redteam.py`가 먼저 잡고 실행기는 직접 부른다(carbon-lock.sh를 거치지 않는다).

```
node ~/sobaegi-lead/results/gpt-web/run.js \
  --prompt <입력.txt> --out <답.txt> --account u0:<profile> \
  --meta <meta.json> --timeout 1800
```

입력 파일은 `--prompt`가 가리키는 파일 하나다. 출력 폴더는 `--out`·`--meta`가 가리키는 곳이며, `redteam.py`가 `--out` 폴더에 `raw_gpt6pro_web.txt`·`raw_gpt6pro_web.meta.json`으로 넘긴다.

`--meta` 파일은 아래 네 칸을 반드시 쓴다. 카본 실행기(`carbon-web-1114/run.js`)가 `modelLabel`·`chatUrl`을 쓰는 것과 같은 자리다.

| 칸 | 값 |
| --- | --- |
| `status` | 성공일 때만 `ok`. 한도·모델 불일치·빈 답·전송 실패는 다른 값(예: `limit`, `fail_model`, `fail_empty`)으로 쓰고 `reason`에 이유를 적는다. |
| `model_shown` | 화면 모델 선택기에 실제로 보인 라벨. `6 Pro`가 들어가야 한다(예: `GPT-6 Pro`). 모델만 적힌 `GPT-6`이나 사고수준만 적힌 `추론 수준 Pro`는 GPT 6 Pro로 세지 않는다. |
| `finished_at` | 끝난 시각, ISO 8601(예: `2026-11-19T05:12:33.000Z`). |
| `answer_path` | 답 파일 경로. `--out`과 같으면 생략해도 된다. 상대 경로면 meta.json이 있는 폴더 기준이다. |

`chat_url`(대화 주소)과 `reason`(실패 이유)은 있으면 함께 적는다.

기존 수동 실행 결과의 `modelShown`은 이 계약의 `model_shown`과 다르므로 그대로는 성공으로 인정하지 않는다.

기존 `carbon-lock.sh`는 별도 구현으로, 죽은 부모의 `cmd` 생존 여부나 claim을 확인하지 않는다. 따라서 셸 잠금과 섞어 쓰는 경우의 경쟁은 이 변경만으로 해결되지 않는다.

받음으로 세는 조건은 셋 다 맞을 때뿐이다. `status == "ok"`, `model_shown`에 `6 Pro`가 들어 있음(대소문자 무시), 답 파일이 비어 있지 않음. 하나라도 어긋나면 '못 받음'으로 남기고 그 이유를 `gpt6pro_web.md` 머리에 적는다. 한도에 걸려 낮은 모델이 답한 경우(`model_shown`이 `GPT-6`뿐)도 '못 받음'이다.

## 시험

```
python3 -m unittest discover -s tools/redteam
```

시험은 진짜 홈을 건드리지 않는다. 임시 `HOME`만 쓰고, 실행기·네트워크는 전부 가짜다.
