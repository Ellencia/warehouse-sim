// 일방통행 손익이 갈리는 로봇 수 재기: node measure.js [분당 주문 수 ...]  (기본 20 120)
// 포장된 수(= 로봇 단계 산출, 트럭과 무관)를 양방향/일방통행으로 비교한다. 씨앗 5개 평균.
const { createSim } = require('./sim.js');
const TICKS = 20000, SEEDS = [1, 2, 3, 4, 5];

function packed(opt) {
  const S = createSim(opt);
  for (let i = 0; i < TICKS; i++) S.tick();
  return { packed: S.dock.length + S.done, created: S.created };
}

const rates = process.argv.slice(2).map(Number);
for (const rate of rates.length ? rates : [20, 120]) {
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
