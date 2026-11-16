/* Substitui o Supabase: mesma "cara" do cliente supabase-js usada pelo painel,
   mas falando com as funções deste próprio site (/api/...). */
(function () {
  const H = { 'X-Painel': '1' };
  async function chamar(url, { method = 'GET', body, gzip = false } = {}) {
    const op = { method, headers: { ...H }, credentials: 'same-origin' };
    if (body !== undefined) {
      const txt = JSON.stringify(body);
      if (gzip && typeof CompressionStream !== 'undefined' && txt.length > 50000) {
        op.body = await new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        op.headers['Content-Type'] = 'application/json'; op.headers['Content-Encoding'] = 'gzip';
      } else { op.body = txt; op.headers['Content-Type'] = 'application/json'; }
    }
    let r;
    try { r = await fetch(url, op); } catch (e) { return { ok: false, status: 0, dados: { erro: 'Sem conexão com o servidor. Confira a internet e tente de novo.' } }; }
    let dados = {}; try { dados = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, dados };
  }
  const erroDe = (res) => ({ message: (res.dados && res.dados.erro) || ('Erro ' + res.status), status: res.status, context: { json: async () => res.dados || {} } });

  let usuario = null;
  const ouvintes = [];

  // Na abertura: se veio de um link do e-mail (?acesso=...), entra com ele e cai na tela de criar senha.
  const inicio = (async () => {
    const url = new URL(location.href);
    const token = url.searchParams.get('acesso');
    let erroLink = '';
    if (token) {
      url.searchParams.delete('acesso'); history.replaceState(null, '', url.pathname + url.search);
      const r = await chamar('/api/auth?acao=token', { method: 'POST', body: { token } });
      if (!r.ok) erroLink = (r.dados && r.dados.erro) || 'Este link expirou ou já foi usado.';
    }
    const res = await chamar('/api/auth');
    return { res, erroLink };
  })();

  const auth = {
    async getSession() {
      const { res, erroLink } = await inicio;
      if (erroLink) document.addEventListener('DOMContentLoaded', () => { const el = document.getElementById('loginError'); if (el) el.textContent = erroLink; });
      if (erroLink && document.readyState !== 'loading') { const el = document.getElementById('loginError'); if (el) el.textContent = erroLink; }
      if (res.ok && res.dados.primeiroUso && !res.dados.usuario) { location.href = '/setup.html'; return { data: { session: null } }; }
      usuario = (res.ok && res.dados.usuario) || null;
      return { data: { session: usuario ? { user: usuario } : null } };
    },
    async signInWithPassword({ email, password }) {
      const res = await chamar('/api/auth?acao=entrar', { method: 'POST', body: { email, senha: password } });
      if (!res.ok) return { data: {}, error: erroDe(res) };
      usuario = res.dados.usuario;
      return { data: { user: usuario, session: { user: usuario } }, error: null };
    },
    async signOut() { await chamar('/api/auth?acao=sair', { method: 'POST' }); usuario = null; return { error: null }; },
    async updateUser({ password }) {
      const res = await chamar('/api/auth?acao=trocar-senha', { method: 'POST', body: { senha: password } });
      if (!res.ok) return { data: {}, error: erroDe(res) };
      usuario = res.dados.usuario;
      return { data: { user: usuario }, error: null };
    },
    async resetPasswordForEmail(email) {
      const res = await chamar('/api/auth?acao=esqueci', { method: 'POST', body: { email } });
      return res.ok ? { data: {}, error: null } : { data: {}, error: erroDe(res) };
    },
    onAuthStateChange(cb) { ouvintes.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
  };

  function from(tabela) {
    const st = { op: 'select', filtros: {}, valor: null };
    const executar = async () => {
      if (tabela === 'roles') {
        if (!usuario) { const s = await auth.getSession(); if (!s.data.session) return { data: null, error: null }; }
        return { data: { role: usuario.papel }, error: null };
      }
      if (tabela !== 'app_data') return { data: null, error: { message: 'Tabela não disponível: ' + tabela } };
      if (st.op === 'upsert') {
        const res = await chamar('/api/dados', { method: 'PUT', body: { id: st.valor.id, rows: st.valor.rows }, gzip: true });
        return res.ok ? { data: null, error: null } : { data: null, error: erroDe(res) };
      }
      if (st.op === 'delete') {
        const res = await chamar('/api/dados?id=' + encodeURIComponent(st.filtros.id), { method: 'DELETE' });
        return res.ok ? { data: null, error: null } : { data: null, error: erroDe(res) };
      }
      const res = await chamar('/api/dados?id=' + encodeURIComponent(st.filtros.id));
      if (!res.ok) return { data: null, error: erroDe(res) };
      return { data: res.dados.existe ? { rows: res.dados.rows } : null, error: null };
    };
    const b = {
      select() { return b; },
      eq(col, val) { st.filtros[col] = val; return b; },
      maybeSingle() { return executar(); },
      single() { return executar(); },
      upsert(v) { st.op = 'upsert'; st.valor = v; return b; },
      delete() { st.op = 'delete'; return b; },
      then(ok, falha) { return executar().then(ok, falha); },
    };
    return b;
  }

  const functions = {
    async invoke(nome, { body } = {}) {
      if (nome !== 'gerenciar-acessos') return { data: null, error: { message: 'Função indisponível.' } };
      const res = await chamar('/api/acessos', { method: 'POST', body });
      if (res.ok && body && (body.acao === 'criar' || body.acao === 'senha')) {
        // a tela mostra "envie a senha para a pessoa"; com e-mail configurado, avisa que já foi enviada
        setTimeout(() => {
          const el = document.getElementById('acessosMsg'); if (!el) return;
          if (res.dados.emailEnviado) { el.style.color = '#1e6b34'; el.textContent = `Senha temporária enviada por e-mail para ${res.dados.email}. No primeiro login a pessoa cria uma senha própria.`; }
          else if (res.dados.falhaEmail) { el.textContent += ` (o e-mail não foi enviado: ${res.dados.falhaEmail} — repasse a senha você mesmo)`; }
        }, 0);
      }
      return res.ok ? { data: res.dados, error: null } : { data: null, error: erroDe(res) };
    },
  };

  window.supabase = { createClient() { return { auth, from, functions }; } };

  // Ajustes de tela quando o e-mail não está configurado: acesso liberado só com senha temporária.
  document.addEventListener('DOMContentLoaded', async () => {
    const { res } = await inicio;
    if (res.ok && res.dados.email) return;
    const modo = document.getElementById('novoModo');
    if (modo) {
      const conv = modo.querySelector('option[value="convite"]'); if (conv) conv.remove();
      modo.value = 'senha'; modo.dispatchEvent(new Event('change'));
    }
    const esq = document.getElementById('esqueciBtn');
    if (esq) {
      esq.disabled = true; esq.style.cursor = 'default'; esq.style.textDecoration = 'none'; esq.style.color = '#78766f'; esq.style.fontWeight = '400';
      esq.textContent = 'Esqueceu a senha? Peça a um administrador uma senha temporária.';
    }
    const estilo = document.createElement('style');
    estilo.textContent = '.acesso-link{display:none!important}';
    document.head.appendChild(estilo);
  });
})();
