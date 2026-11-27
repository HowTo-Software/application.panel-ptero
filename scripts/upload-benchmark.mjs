#!/usr/bin/env node
/**
 * Mede a vazão REAL de upload do painel até o Wings (navegador -> node), sem alterar nada além de
 * arquivos temporários que ele mesmo apaga. Rode contra um servidor de HOMOLOGAÇÃO, a partir da rede
 * de onde os usuários enviam arquivos.
 *
 *   PANEL_URL=https://painel.exemplo.com API_KEY=ptlc_xxx SERVER=<uuid-curto-ou-completo> \
 *   node scripts/upload-benchmark.mjs [--size-mb 200] [--runs 3] [--parallel 1,2,4] [--dir /]
 *
 * API_KEY: chave de API de CONTA (client API). Nunca a coloque em arquivo versionado ou em chat.
 * Requer Node >= 18 (fetch/FormData/Blob globais).
 *
 * --parallel N  = N ARQUIVOS enviados ao mesmo tempo (N conexões TCP). Não é upload fragmentado de um
 *                 único arquivo (isso exige suporte no Wings); serve para ver se várias conexões somam
 *                 vazão no seu caminho de rede.
 * Cada tentativa usa um token novo (o token do Wings vale uma única requisição).
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};

const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const SERVER = process.env.SERVER || '';
const SIZE_MB = Number(opt('size-mb', '100'));
const RUNS = Number(opt('runs', '3'));
const PARALLEL = opt('parallel', '1').split(',').map(Number);
const DIR = opt('dir', '/');

if (!PANEL_URL || !API_KEY || !SERVER) {
    console.error('Defina PANEL_URL, API_KEY e SERVER (veja o cabeçalho do script).');
    process.exit(2);
}
if (!(SIZE_MB > 0) || !(RUNS > 0) || PARALLEL.some((n) => !(n > 0))) {
    console.error('Valores inválidos para --size-mb/--runs/--parallel.');
    process.exit(2);
}

const headers = { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' };

const api = async (path, init = {}) => {
    const res = await fetch(`${PANEL_URL}/api/client/servers/${SERVER}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
};

// Um único pedaço de 1 MiB aleatório reaproveitado: o Blob referencia o mesmo buffer, sem alocar SIZE_MB na RAM.
const chunk = new Uint8Array(1024 * 1024);
for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536));
const makeBlob = (mb) => new Blob(Array.from({ length: mb }, () => chunk));

const uploadOne = async (name) => {
    const { data } = await (await api('/files/upload')).json().then((j) => ({ data: j.attributes }));
    const form = new FormData();
    form.append('files', makeBlob(SIZE_MB), name);

    const url = new URL(data.url);
    url.searchParams.set('directory', DIR);

    const start = performance.now();
    const res = await fetch(url, { method: 'POST', body: form });
    const seconds = (performance.now() - start) / 1000;
    if (!res.ok) throw new Error(`upload -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

    return { name, seconds, bytes: SIZE_MB * 1024 * 1024 };
};

const cleanup = (names) =>
    api('/files/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: DIR, files: names }) }).catch(
        (e) => console.error(`aviso: não consegui apagar ${names.join(', ')}: ${e.message}`)
    );

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`Painel: ${PANEL_URL}  Servidor: ${SERVER}  Diretório: ${DIR}  Arquivo: ${SIZE_MB} MiB  Rodadas: ${RUNS}`);
console.log('MB/s = 1.000.000 bytes/s. Resultados são MEDIÇÕES deste ambiente/rede, não estimativas.\n');

for (const n of PARALLEL) {
    const rates = [];
    for (let run = 1; run <= RUNS; run++) {
        const names = Array.from({ length: n }, (_, i) => `.bench-${Date.now()}-${run}-${i}.tmp`);
        const start = performance.now();
        try {
            const results = await Promise.all(names.map((name) => uploadOne(name)));
            const wall = (performance.now() - start) / 1000;
            const total = results.reduce((s, r) => s + r.bytes, 0);
            const rate = total / wall / 1_000_000;
            rates.push(rate);
            console.log(`paralelo=${n} rodada ${run}/${RUNS}: ${rate.toFixed(2)} MB/s agregado (${wall.toFixed(1)} s)`);
        } catch (error) {
            console.log(`paralelo=${n} rodada ${run}/${RUNS}: FALHOU - ${error.message}`);
        } finally {
            await cleanup(names);
        }
    }
    if (rates.length) {
        console.log(`  => paralelo=${n}: mediana ${median(rates).toFixed(2)} MB/s, min ${Math.min(...rates).toFixed(2)}, máx ${Math.max(...rates).toFixed(2)} (${rates.length}/${RUNS} ok)\n`);
    }
}
