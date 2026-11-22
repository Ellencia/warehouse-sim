// 일방통행 손익이 갈리는 로봇 수 재기: node measure.js [분당 주문 수 ...]  (기본 20 120)
// 포장된 수(= 로봇 단계 산출, 트럭과 무관)를 양방향/일방통행으로 비교한다. 씨앗 5개 평균.
// 다른 측정: node measure.js jam (막힘 원인 가르기) · node measure.js forks (지게차 대수)
const { createSim } = require('./sim.js');
const TICKS = 20000, SEEDS = [1, 2, 3, 4, 5];

function packed(opt) {
  const S = createSim(opt);
  for (let i = 0; i < TICKS; i++) S.tick();
  return { packed: S.dock.length + S.done, created: S.created };
}

// node measure.js jam — 로봇이 이동 중 막혀 선 틱을 선 자리와 원인으로 가른다.
// 원인은 "누가 내 다음 칸을 막나"를 줄 맨 앞까지 따라가서 정한다. 입고 10배 = 트럭 24틱마다·지게차 4대.
function jam() {
  const WORK = ['picking', 'returning', 'dropping'];
  const KEYS = ['작업대 처리', '벨트 참', '선반 작업 중인 로봇 뒤', '마주 보고 얽힘', '한 박자 양보'];
  for (const [robots, rate] of [[4, 20], [8, 60], [12, 120]]) for (const oneWay of [false, true]) {
    const root = Object.fromEntries(KEYS.map(k => [k, 0])), where = { 통로: 0, 뒷줄: 0, 앞줄: 0 };
    let stuck = 0, moving = 0, sum = 0, fed = 0;
    for (const seed of SEEDS) {
      const S = createSim({ robots, rate, oneWay, seed });
      const parked = r => WORK.includes(r.state) || (r.state === 'idle' && r.cell === r.home);
      const isStuck = r => !parked(r) && r.cell === r.prev && r.path && r.path.length;
      for (let i = 0; i < TICKS; i++) {
        S.tick();
        const at = new Map(S.robots.map(r => [r.cell, r]));
        for (const r of S.robots) {
          if (parked(r)) continue;
          moving++;
          if (!isStuck(r)) continue;
          stuck++;
          const y = (r.cell / S.W) | 0;
          where[y < S.aisleY[0] ? '뒷줄' : y > S.aisleY[1] ? '앞줄' : '통로']++;
          const seen = new Set();
          for (let b = r; ;) {
            seen.add(b);
            const n = at.get(b.path[0]);
            const why = !n || (!WORK.includes(n.state) && !isStuck(n)) ? KEYS[4]
              : n.state === 'dropping' ? KEYS[n.timer > 0 ? 0 : 1] : WORK.includes(n.state) ? KEYS[2] : seen.has(n) ? KEYS[3] : null;
            if (why) { root[why]++; break; }
            b = n;
          }
        }
      }
      sum += S.dock.length + S.done;
      fed += packed({ robots, rate, oneWay, seed, inboundEvery: 24, forklifts: 4 }).packed;
    }
    const pct = v => (100 * v / stuck).toFixed(0) + '%', n = SEEDS.length;
    console.log(`\n로봇 ${robots}·분당 ${rate}·${oneWay ? '일방통행' : '양방향'}: 포장 ${(sum / n).toFixed(0)} (입고 10배 ${(fed / n).toFixed(0)}), 이동 중 막혀 선 틱 ${(100 * stuck / moving).toFixed(1)}%`);
    console.log('  선 자리: ' + Object.entries(where).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
    console.log('  원인: ' + KEYS.map(k => `${k} ${pct(root[k])}`).join(', '));
  }
}

// node measure.js forks — 지게차 대수별 포장 수와 품절 대기
function forks() {
  for (const [robots, rate] of [[4, 20], [12, 120]]) for (const forklifts of [1, 2, 3]) {
    let sum = 0, back = 0, left = 0;
    for (const seed of SEEDS) {
      const S = createSim({ robots, rate, oneWay: robots > 4, forklifts, seed });
      for (let i = 0; i < TICKS; i++) S.tick();
      sum += S.dock.length + S.done; back += S.avgSec(S.back);
      left += S.pending.filter(o => o.tOut !== undefined).length;
    }
    const n = SEEDS.length;
    console.log(`로봇 ${robots}·분당 ${rate}${robots > 4 ? '·일방통행' : ''}·지게차 ${forklifts}: 포장 ${(sum / n).toFixed(0)}, 품절 대기(끝 50건 평균) ${(back / n).toFixed(1)}초, 끝에 품절로 막힌 주문 ${(left / n).toFixed(1)}`);
  }
}

const mode = { jam, forks }[process.argv[2]];
if (mode) mode();
const rates = process.argv.slice(2).map(Number);
for (const rate of mode ? [] : rates.length ? rates : [20, 120]) {
  console.log(`\n분당 ${rate} · ${TICKS}틱 · 씨앗 ${SEEDS.length}개 평균`);
  console.log('로봇  주문    양방향  일방통행  차이    일방통행이 이긴 씨앗');
  for (let robots = 1; robots <= 12; robots++) {
    let two = 0, one = 0, created = 0, wins = 0;
    for (const seed of SEEDS) {
      const a = packed({ robots, rate, seed }), b = packed({ robots, rate, seed, oneWay: true });
      two += a.packed; one += b.packed; created += a.created;
      if (b.packed > a.packed) wins++;
    }
    const n = SEEDS.length, f = v => (v / n).toFixed(0).padStart(6);
    console.log(`${String(robots).padStart(3)} ${f(created)}  ${f(two)}  ${f(one)}  ${((one - two) / n).toFixed(0).padStart(6)}    ${wins}/${n}`);
  }
}
