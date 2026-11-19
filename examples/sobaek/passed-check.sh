#!/bin/bash
set -euo pipefail
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --passed) passed="${2:-}"; shift 2 ;;
    *) files+=("$1"); shift ;;
  esac
done
passed="${passed:-}"
[ ${#files[@]} -gt 0 ] || exit 0
python3 -X utf8 -c 'import hashlib,os,re,sys
folder,names=sys.argv[1],sys.argv[2:]
labels=names
if os.environ.get("PASSED_LABELS"):
    labels=os.fsdecode(open(os.environ["PASSED_LABELS"],"rb").read()).split("\0")[:-1]
def refuse(name,why): print("REFUSED %s is not the passed copy: %s" % (name,why),file=sys.stderr); sys.exit(65)
if not folder: refuse(labels[0],"no --passed review round folder was named")
verdict=os.path.join(folder,"verdict.txt")
try: lines=open(verdict,encoding="utf-8").read().splitlines()
except OSError: refuse(labels[0],"%s cannot be read" % verdict)
if not lines or lines[0].strip()!="나가도 됩니다": refuse(labels[0],"%s does not say 나가도 됩니다 on its first line" % verdict)
# 통과한 판이 그 결과물의 최신판인지 가린다: 같은 상위 폴더의 형제 라운드(verdict.txt 수정시각, 같은 접두사면 이름 끝 숫자) 중
# 같은 결과물(보내는 파일의 sha256, 또는 이 판 해시 줄과 같은 경로)을 본 라운드의 더 최신 판정이 이긴다. 데스크는 앞 판을
# 읽고 같은 바이트를 다시 막을 수 있으므로 옛 통과만으로는 보내지 않는다. 한 폴더에 여러 계열이 함께 검수되면
# 다른 결과물의 라운드는 이 파일을 건드리지 않는다.
def number(name):
    m=re.match(r"^(.*?)([0-9]+)$",name); return (m.group(1),int(m.group(2))) if m else None
def when(path):
    try: return os.path.getmtime(os.path.join(path,"verdict.txt"))
    except OSError: return None
def pairs_of(ls):
    out=[]
    for l in ls[1:]:
        w=l.split()
        if len(w)>1 and re.fullmatch(r"[0-9a-f]{64}",w[0]): out.append((" ".join(w[1:]),w[0]))
        elif len(w)>1 and re.fullmatch(r"[0-9a-f]{64}",w[-1]): out.append((" ".join(w[:-1]),w[-1]))
    return out
folder=os.path.abspath(folder); parent=os.path.dirname(folder)
mine,mine_no=when(folder),number(os.path.basename(folder))
cands=[]
for n in sorted(os.listdir(parent)):
    q=os.path.join(parent,n); mt=when(q); no=number(n)
    if q==folder or not os.path.isdir(q) or mt is None: continue
    if (mine is not None and mt>mine) or (mine_no and no and no[0]==mine_no[0] and no[1]>mine_no[1]): cands.append((mt,n,q))
sib=[]
for mt,n,q in sorted(cands,reverse=True):
    try: qlines=open(os.path.join(q,"verdict.txt"),encoding="utf-8").read().splitlines()
    except OSError: continue
    sib.append((n,q,(qlines[0].strip() if qlines else ""),pairs_of(qlines)))
# 나열 해시는 마디가 sha256(소문자 16진 64자)로 끝나는 줄만 센다. 검수 모델이 읽지 않은 파일은 경로가 아니라 해시로 가린다:
# review.py 는 `읽지 않고 함께 나가는 파일` 줄에 글 폴더 기준 상대 경로를 ", " 로 이어 쓰고, 그 파일의 해시도 해시 줄에
# 올리므로, 그 상대 경로와 경로 경계(`/`)에서 같은 해시 줄의 sha256 묶음에 드는 바이트는 통과 판이 아니다(--send-without-desk-review 로만 나간다).
pairs=pairs_of(lines)
listed={h for _,h in pairs}
if not listed:
    print("해시 없음",file=sys.stderr)
    sys.exit(0)
unread_hashes=set()
for l in lines[1:]:
    if l.startswith("읽지 않고 함께 나가는 파일"):
        for u in l.split(":",1)[-1].split(", "):
            u=u.strip()
            if u: unread_hashes|={h for p,h in pairs if p==u or p.endswith("/"+u)}
for i,name in enumerate(names):
    digest=hashlib.sha256(open(name,"rb").read()).hexdigest()
    name=labels[i]
    if digest in unread_hashes:
        refuse(name,"검수 모델이 읽지 않은 파일이라 --send-without-desk-review 로만 보낼 수 있습니다")
    if digest not in listed: refuse(name,"its sha256 is not listed in %s" % verdict)
    paths={p for p,h in pairs if h==digest}
    for n,q,first,qp in sib:
        if digest in {h for _,h in qp} or (paths & {p for p,_ in qp}):
            if first!="나가도 됩니다": refuse(name,"더 최신 교열 라운드 %s 가 이 판을 나가지 못하게 했습니다(%s)" % (n,os.path.join(q,"verdict.txt")))
            refuse(name,"더 최신 교열 라운드 %s 의 판정이 있으니 그 라운드를 --passed 로 지정해야 합니다" % n)' "$passed" "${files[@]}"
