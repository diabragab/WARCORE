import '@fontsource/chakra-petch/400.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import './landing.css';

document.getElementById('year')!.textContent = String(new Date().getFullYear());

interface Leader { name: string; value: number; rank: string; vip: boolean }

/** Fills the leaderboard section from the game server. */
async function loadLeaders() {
  let data: Record<'rating' | 'wins' | 'arcade', Leader[]>;
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    document.getElementById('leaders')!.hidden = true;
    return;
  }
  const fmt: Record<string, (v: number) => string> = { rating: String, wins: (v) => `${v} ${v === 1 ? 'win' : 'wins'}`, arcade: (v) => `wave ${v}` };
  for (const board of ['rating', 'wins', 'arcade'] as const) {
    const list = document.getElementById(`lb-${board}`)!;
    const rows = data[board].map((l) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.name;
      const rank = document.createElement('span');
      rank.className = `tag ${l.rank.toLowerCase()}`;
      rank.textContent = l.rank;
      li.append(name, rank);
      if (l.vip) {
        const vip = document.createElement('span');
        vip.className = 'tag vip';
        vip.textContent = 'VIP';
        li.append(vip);
      }
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = fmt[board](l.value);
      li.append(value);
      return li;
    });
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No one yet. Be the first!';
      rows.push(li);
    }
    list.replaceChildren(...rows);
  }
}
loadLeaders();
