// 창고 로직. 화면 없이 돈다. 자가 검사: node sim.js
(function (root) {
  const W = 13, H = 11, TPS = 4;               // 로봇 구역 격자, 초당 틱 수 (1틱 = 로봇 한 칸)
  const SHELF_X = [1, 2, 4, 5, 7, 8, 10, 11];  // 등 맞댄 선반 두 줄씩, 사이 통로는 한 칸 폭
  const SHELF_Y0 = 2, SHELF_Y1 = 8;
  const PICK_TICKS = 3, STATION_TICKS = 4, PACK_TICKS = 3; // 집기, 작업대 처리, 벨트 끝 포장
  const STOCK_CAP = 6;                         // 상자 하나에 든 물건 수 (가득일 때)
  const WINDOW = 480;                         // 분당 처리량을 재는 구간(틱) = 2분
  const TRUCK_STAY = 24;                       // 트럭이 머무는 틱(1틱에 한 상자 싣는다). 문 앞 적치는 한도 없음:
                                               // 출고가 밀려도 로봇 단계에는 영향이 없다 (두 단계를 따로 보려고 끊어 둠)
  const LEVELS = 3, LEVEL_TICKS = 2;          // 선반 단수, 한 단 올라갈 때마다 더 걸리는 집는 시간
  const INBOUND_CAP = 24;                      // 입고 트럭 한 대가 싣고 오는 보충 상자 수
  const FORK_HOME = [12, -2];                  // 지게차 대기 자리 = 하역장 (구역 밖 뒤쪽 오른편)
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const idx = (x, y) => y * W + x;
  const AISLE_DIR = { 0: 1, 3: -1, 6: 1, 9: -1, 12: 1 }; // 일방통행일 때 통로 x → 허용 방향 (+1 = 앞쪽 작업대 방향)
  const inAisle = (x, y) => AISLE_DIR[x] !== undefined && y >= SHELF_Y0 && y <= SHELF_Y1;
  const STATION_X = [1, 4, 8, 11];
  const DROPS = STATION_X.map(x => idx(x, 10)); // 작업대 앞 칸 (맨 앞줄). 로봇이 여기 서서 넘긴다
  // 컨베이어: 구역 밖 앞변(y=12)을 오른쪽→왼쪽으로 지나 왼쪽 변(x=-2)을 타고 뒤로. 끝 칸이 포장.
  const BELT = [];
  for (let x = 12; x >= -2; x--) BELT.push([x, 12]);
  for (let y = 11; y >= 3; y--) BELT.push([-2, y]);
  const beltAt = cell => 12 - (cell % W);       // 작업대 칸 → 그 앞 벨트 칸 번호

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createSim(opt = {}) {
    const rng = mulberry32(opt.seed ?? 1);
    const wall = new Uint8Array(W * H);        // 1 선반
    const occ = new Int16Array(W * H).fill(-1); // 칸 → 로봇 번호
    const shelves = [];
    SHELF_X.forEach((x, i) => {
      for (let y = SHELF_Y0; y <= SHELF_Y1; y++) {
        wall[idx(x, y)] = 1;
        shelves.push({ cell: idx(x, y), pick: idx(i % 2 === 0 ? x - 1 : x + 1, y) });
      }
    });
    const pickOf = new Map(shelves.map(s => [s.cell, s.pick]));

    // 상자 자리 = 물건 한 종류. 인기 순으로 한 줄 세운다 (창고 안 위치와는 무관하게 섞어서)
    const skus = shelves.flatMap(s => Array.from({ length: LEVELS }, (_, level) => ({ s, level })));
    for (let i = skus.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [skus[i], skus[j]] = [skus[j], skus[i]]; }

    const S = {
      W, H, TPS, LEVELS, wall, shelves, robots: [], pending: [],
      STOCK_CAP, stock: new Uint8Array(W * H * LEVELS).fill(STOCK_CAP), // 자리별 남은 수량
      // 바닥난 자리 → 'ordered'(다음 입고 트럭을 기다림) | 'dock'(하역장에 내려짐) | 'fork'(지게차가 나르는 중). 넣은 순서대로 처리
      refill: new Map(),
      inboundEvery: opt.inboundEvery ?? 240, inboundT: 0, // 입고 트럭 간격(틱)
      // 지게차. k = 나르는 자리(-1 쉼), t = 출발 뒤 틱, travel = 편도 틱, go = 채워 넣는 틱. (px,py) = 선반 앞 칸
      forks: Array.from({ length: opt.forklifts ?? 1 }, () => ({ k: -1, t: 0, travel: 0, go: 0, px: 0, py: 0 })),
      forkHome: FORK_HOME,
      stationX: STATION_X, beltPath: BELT, belt: new Array(BELT.length).fill(null), packT: 0,
      dock: [],                    // 포장돼서 트럭을 기다리는 상자
      truckEvery: opt.truckEvery ?? 160, truckT: 0, truckHere: false, // 트럭이 떠난 뒤 다시 올 때까지의 틱
      out: new Set(),             // 로봇이 맡아서 선반에 없는(곧 없을) 상자 자리. 돌아올 때까지 그 자리 주문은 기다린다
      t: 0, created: 0, done: 0,
      // 단계별 계측. robot = 주문→포장 끝, truck = 포장 끝→트럭에 실림. log는 끝난 틱, dur는 걸린 틱(최근 50건)
      robot: { log: [], dur: [] }, truck: { log: [], dur: [] },
      want: opt.robots ?? 4,       // 로봇 대수 (다음 틱에 맞춰짐)
      rate: opt.rate ?? 20,        // 분당 주문 수
      rule: opt.rule ?? 'nearest', // 'nearest' | 'longestIdle'
      oneWay: opt.oneWay ?? false, // 선반 사이 통로 일방통행 (통로마다 방향이 번갈아 바뀐다)
      aisleDir: AISLE_DIR, aisleY: [SHELF_Y0, SHELF_Y1],
      tick,
      avgSec: st => st.dur.length ? st.dur.reduce((a, b) => a + b, 0) / st.dur.length / TPS : 0,
      perMin: st => st.log.length / (Math.min(WINDOW, S.t || 1) / TPS / 60), // 최근 2분 기준 분당 처리량
    };
    function mark(st, dur) {
      st.log.push(S.t);
      st.dur.push(dur);
      if (st.dur.length > 50) st.dur.shift();
    }

    // 일방통행이면 통로에 들어가고, 통로 안에서 움직이고, 나오는 걸음은 전부 그 통로 방향이어야 한다
    const legal = (cx, cy, nx, ny) =>
      !S.oneWay || !(inAisle(cx, cy) || inAisle(nx, ny)) || ny - cy === AISLE_DIR[cx];
    const legalStep = (c, n) => legal(c % W, (c / W) | 0, n % W, (n / W) | 0);

    // 최단 경로(칸 목록, 출발 칸 제외). avoid=true 면 다른 로봇이 선 칸도 벽 취급.
    function bfs(start, goals, avoid) {
      const prev = new Int16Array(W * H).fill(-1);
      const q = [start];
      prev[start] = start;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        if (goals.includes(c)) {
          const path = [];
          for (let p = c; p !== start; p = prev[p]) path.push(p);
          return path.reverse();
        }
        const cx = c % W, cy = (c - cx) / W;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = idx(nx, ny);
          if (wall[n] || prev[n] !== -1 || (avoid && occ[n] !== -1) || !legal(cx, cy, nx, ny)) continue;
          prev[n] = c;
          q.push(n);
        }
      }
      return null;
    }

    function syncRobots() {
      while (S.robots.length > S.want) {
        const r = S.robots.pop();
        occ[r.cell] = -1;
        if (r.order) S.pending.unshift(r.order); // 들고 있던 주문은 대기열 맨 앞으로
        const held = r.order || r.tote;
        if (held) S.out.delete(slot(held));      // 상자는 제자리로 돌아간 셈 친다
      }
      while (S.robots.length < S.want) {
        const id = S.robots.length, home = idx(id, 0);
        if (occ[home] !== -1) break;             // 누가 서 있으면 다음 틱에 다시
        occ[home] = id;
        S.robots.push({ id, home, cell: home, prev: home, state: 'idle', order: null, tote: null, path: null, timer: 0, blocked: 0, idleSince: S.t });
      }
    }

    const slot = o => o.shelf * LEVELS + o.level;

    function assign() {
      for (;;) {
        const idle = S.robots.filter(r => r.state === 'idle');
        if (!idle.length) break;
        // 상자가 선반에 있고 재고도 남은, 가장 오래된 주문. 품절 자리 주문은 채워질 때까지 건너뛴다
        const i = S.pending.findIndex(o => !S.out.has(slot(o)) && S.stock[slot(o)] > 0);
        if (i < 0) break;
        const o = S.pending.splice(i, 1)[0];
        S.out.add(slot(o));
        const cost = S.rule === 'nearest' ? r => bfs(r.cell, [o.pick], false).length : r => r.idleSince;
        const best = idle.reduce((a, b) => (cost(b) < cost(a) ? b : a));
        best.order = o; best.state = 'toPick'; best.path = null; best.blocked = 0;
      }
    }

    function step(r) {
      if (r.state === 'picking' || r.state === 'dropping' || r.state === 'returning') {
        if (r.timer > 0 && --r.timer > 0) return;
        if (r.state === 'picking') r.state = 'toDrop';
        else if (r.state === 'dropping') {
          const k = beltAt(r.cell);
          if (S.belt[k]) return;               // 벨트 칸이 차 있으면 로봇이 작업대에서 기다린다 (역압)
          r.order.bi = r.order.bp = k;
          S.belt[k] = r.order;
          if (--S.stock[slot(r.order)] === 0) S.refill.set(slot(r.order), 'ordered'); // 바닥나면 발주
          r.tote = r.order;                   // 물건은 벨트로, 빈 상자는 로봇이 도로 가져간다
          r.order = null; r.state = 'toReturn';
        } else {
          S.out.delete(slot(r.tote));
          r.tote = null; r.state = 'idle'; r.idleSince = S.t;
        }
        r.path = null;
        return;
      }
      const goals = r.state === 'toPick' ? [r.order.pick] : r.state === 'toDrop' ? DROPS
        : r.state === 'toReturn' ? [r.tote.pick] : [r.home];
      if (goals.includes(r.cell)) {
        if (r.state === 'toPick') { r.state = 'picking'; r.timer = PICK_TICKS + LEVEL_TICKS * r.order.level; }
        else if (r.state === 'toDrop') { r.state = 'dropping'; r.timer = STATION_TICKS; }
        else if (r.state === 'toReturn') { r.state = 'returning'; r.timer = PICK_TICKS + LEVEL_TICKS * r.tote.level; }
        return;
      }
      // 길이 없거나, 도중에 일방통행이 켜져서 다음 걸음이 역주행이 됐으면 다시 찾는다
      if (!r.path || !r.path.length || !legalStep(r.cell, r.path[0])) r.path = bfs(r.cell, goals, false);
      if (occ[r.path[0]] !== -1) {
        if (++r.blocked < 2) return;
        const alt = bfs(r.cell, goals, true);
        if (alt) r.path = alt;
        else {
          // ponytail: 길이 아예 없으면 6틱 뒤 빈 옆 칸으로 아무 데나 비켜서 교착을 푼다.
          // 통로 일방통행·칸 예약 같은 진짜 교통 규칙이 필요해지면 여기를 갈아 끼울 것.
          if (r.blocked < 6) return;
          const cx = r.cell % W, cy = (r.cell - cx) / W;
          const free = DIRS.map(([dx, dy]) => [cx + dx, cy + dy])
            .filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && !wall[idx(x, y)] && occ[idx(x, y)] === -1 && legal(cx, cy, x, y));
          if (!free.length) return;
          const [x, y] = free[(rng() * free.length) | 0];
          r.path = [idx(x, y)];
        }
      }
      occ[r.cell] = -1;
      r.cell = r.path.shift();
      occ[r.cell] = r.id;
      r.blocked = 0;
    }

    // 트럭: 간격마다 와서 머무는 동안 1틱에 한 상자씩 싣는다. 실린 순간이 주문 완료.
    function truck() {
      S.truckT++;
      if (!S.truckHere && S.truckT >= S.truckEvery) { S.truckHere = true; S.truckT = 0; }
      if (!S.truckHere) return;
      if (S.dock.length) {
        S.done++;
        mark(S.truck, S.t - S.dock.shift().tPack);
      }
      if (S.truckT >= TRUCK_STAY) { S.truckHere = false; S.truckT = 0; }
    }

    // 입고: 트럭이 간격마다 와서 발주된 자리의 보충 상자를 하역장에 내리고, 지게차가 하나씩 선반에 채운다.
    // ponytail: 트럭은 도착한 순간 통째로 내린다(하역 시간 없음). 지게차는 로봇 칸을 차지하지 않고 지나간다
    // (하역장→뒷줄→통로, 거리만큼 시간만 든다). 지게차가 통로를 막는 효과를 보려면 로봇과 같은 occ 격자에 올릴 것.
    function inbound() {
      if (++S.inboundT >= S.inboundEvery) {
        S.inboundT = 0;
        let n = INBOUND_CAP;
        for (const [k, v] of S.refill) if (v === 'ordered' && n-- > 0) S.refill.set(k, 'dock');
      }
      for (const f of S.forks) {
        if (f.k < 0) {
          const hit = [...S.refill].find(([, v]) => v === 'dock');
          if (!hit) continue;
          const k = hit[0], p = pickOf.get((k / LEVELS) | 0);
          S.refill.set(k, 'fork');
          f.k = k; f.t = 0; f.px = p % W; f.py = (p / W) | 0;
          f.travel = Math.abs(FORK_HOME[0] - f.px) + f.py - FORK_HOME[1];
          f.go = f.travel + PICK_TICKS + LEVEL_TICKS * (k % LEVELS);
        }
        f.t++;
        if (f.t === f.go) { S.stock[f.k] = STOCK_CAP; S.refill.delete(f.k); }
        if (f.t >= f.go + f.travel) f.k = -1;
      }
    }

    // 벨트: 끝 칸은 포장 중, 나머지는 앞 칸이 비었을 때만 한 칸 전진
    function moveBelt() {
      const b = S.belt, last = b.length - 1;
      for (const o of b) if (o) o.bp = o.bi;
      if (b[last] && ++S.packT >= PACK_TICKS) {
        b[last].tPack = S.t;
        mark(S.robot, S.t - b[last].t0);
        S.dock.push(b[last]);
        b[last] = null; S.packT = 0;
      }
      for (let i = last - 1; i >= 0; i--) if (b[i] && !b[i + 1]) { b[i + 1] = b[i]; b[i] = null; b[i + 1].bi = i + 1; }
    }

    function tick() {
      S.t++;
      for (const st of [S.robot, S.truck]) while (st.log[0] <= S.t - WINDOW) st.log.shift();
      syncRobots();
      truck();
      moveBelt();
      inbound();
      const e = S.rate / 60 / TPS;
      for (let n = Math.floor(e) + (rng() < e % 1 ? 1 : 0); n > 0; n--) {
        const { s, level } = skus[(skus.length * rng() ** 2) | 0]; // 제곱이라 앞쪽(인기 물건)이 훨씬 자주 뽑힌다
        S.pending.push({ id: ++S.created, shelf: s.cell, level, pick: s.pick, t0: S.t });
      }
      assign();
      for (const r of S.robots) { r.prev = r.cell; step(r); }
    }

    syncRobots();
    return S;
  }

  function demo() {
    const assert = require('assert');
    for (const [robots, rate, rule, oneWay] of [[1, 5, 'nearest'], [4, 20, 'nearest'], [4, 20, 'longestIdle'], [12, 120, 'nearest'], [4, 20, 'nearest', true], [12, 120, 'nearest', true]]) {
      const S = createSim({ robots, rate, rule, oneWay, seed: 7 });
      let doneAt = 0;
      for (let i = 0; i < 20000; i++) {
        if (i === 18000) doneAt = S.done;
        if (robots === 12 && i === 8000) S.want = 3;   // 도중에 로봇을 빼고
        if (robots === 12 && i === 12000) S.want = 12; // 다시 넣어도 주문이 새지 않아야 한다
        S.tick();
        const cells = S.robots.map(r => r.cell);
        assert.strictEqual(new Set(cells).size, cells.length, '두 로봇이 한 칸에');
        for (const r of S.robots) {
          assert(!S.wall[r.cell], '로봇이 선반 안에');
          const x = r.cell % W, y0 = (r.prev / W) | 0, y1 = (r.cell / W) | 0;
          if (oneWay && y0 !== y1 && (inAisle(x, y0) || inAisle(x, y1))) assert.strictEqual(y1 - y0, AISLE_DIR[x], '역주행');
          assert(Math.abs(r.cell % W - r.prev % W) + Math.abs(((r.cell / W) | 0) - ((r.prev / W) | 0)) <= 1, '한 틱에 두 칸');
        }
        assert.strictEqual(S.created, S.pending.length + S.robots.filter(r => r.order).length + S.belt.filter(Boolean).length + S.dock.length + S.done, '주문이 샜다');        assert(S.stock.every(n => n <= S.STOCK_CAP), '재고가 음수로 내려갔다'); // Uint8이라 음수는 255로 보인다
        assert.strictEqual(S.refill.size, S.stock.filter(n => n === 0).length, '품절 자리와 입고 대기가 안 맞는다');
        assert.strictEqual([...S.refill.values()].filter(v => v === 'fork').length, S.forks.filter(f => f.k >= 0 && f.t < f.go).length, '지게차가 나르는 수가 안 맞는다');
        assert.strictEqual(S.out.size,S.robots.filter(r => r.order || r.tote).length, '나간 상자 수가 안 맞는다');
      }
      assert(S.done > doneAt, '교착: 마지막 2000틱 동안 완료 0건');
      console.log(`로봇 ${robots} · 분당 ${rate} · ${rule}${oneWay ? ' · 일방통행' : ''}: 완료 ${S.done}/${S.created}, 대기 ${S.pending.length}(품절 ${S.pending.filter(o => !S.stock[o.shelf * LEVELS + o.level]).length}), 품절 자리 ${S.refill.size}(${['ordered', 'dock', 'fork'].map(v => [...S.refill.values()].filter(x => x === v).length).join('/')}), 로봇 단계 ${S.perMin(S.robot).toFixed(1)}/분 ${S.avgSec(S.robot).toFixed(1)}초, 트럭 단계 ${S.perMin(S.truck).toFixed(1)}/분 ${S.avgSec(S.truck).toFixed(1)}초`);
    }
    // 트럭이 오든 말든 로봇 단계는 똑같이 돌아야 한다 (같은 씨앗이면 포장된 수가 정확히 같다)
    const packed = truckEvery => {
      const J = createSim({ robots: 8, rate: 60, seed: 7, truckEvery });
      for (let i = 0; i < 5000; i++) J.tick();
      return J.dock.length + J.done;
    };
    assert.strictEqual(packed(1e9), packed(40), '트럭이 로봇 단계에 영향을 줬다');
    console.log(`트럭 없음/있음 포장 수 동일: ${packed(1e9)}`);
    console.log('ok');
  }

  root.createSim = createSim;
  if (typeof module !== 'undefined') {
    module.exports = { createSim };
    if (require.main === module) demo();
  }
})(typeof window !== 'undefined' ? window : globalThis);
