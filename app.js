/* =========================================================
   Painel DA LOJA — Transferências Clima Rio · SUPABASE
   ========================================================= */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://dwmijhwfhocfabwmppcc.supabase.co";
const SUPABASE_KEY = "sb_publishable_FqBFg4MmpasHAZ_RNjobYQ_6FqEQyG1";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const LIMITE_ARQUIVO = 500 * 1024;

const DIAS_SEMANA = [
  { n: 1, label: "Segunda-feira" }, { n: 2, label: "Terça-feira" },
  { n: 3, label: "Quarta-feira" },  { n: 4, label: "Quinta-feira" },
  { n: 5, label: "Sexta-feira" },   { n: 6, label: "Sábado" },
  { n: 0, label: "Domingo" }
];

let usuarioAtual = null; // linha da tabela usuarios
let filiais = [];
let transferenciasCache = {};
let vendasCache = {};
let transferenciaEmEdicao = null;
let diaLiberado = null;
let regrasCache = [];
let ajusteVendaId = null;

/* ⬇ Permissões por role ⬇
   gestor / supervisor → veem sugestões + todos os pedidos avulsos da filial + autorizações
   vendedor (e demais) → NÃO veem sugestões, só os próprios pedidos avulsos */
function ehGestor() {
  return ["gestor", "supervisor"].includes(usuarioAtual?.role);
}

/* ---------- Utilitários ---------- */
function $(id) { return document.getElementById(id); }

function mostrarToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function nomeLoja(id) {
  const f = filiais.find(x => x.id === id);   // tabela "filiais" do Supabase
  return f ? `${f.id} - ${f.nome}` : id;      // ⬅ sempre "código - nome"
}

function dataHoraBr(iso) {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function lerArquivo(inputFile) {
  return new Promise((resolve, reject) => {
    const arquivo = inputFile.files[0];
    if (!arquivo) { reject(new Error("Selecione um arquivo.")); return; }
    if (arquivo.size > LIMITE_ARQUIVO) { reject(new Error("Arquivo muito grande (máx. 500 KB).")); return; }
    const reader = new FileReader();
    reader.onload = () => resolve({ nome: arquivo.name, conteudo: reader.result });
    reader.onerror = () => reject(new Error("Falha ao ler o arquivo."));
    reader.readAsDataURL(arquivo);
  });
}

function lerArquivoBruto(arquivo) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Falha ao ler " + arquivo.name));
    reader.readAsDataURL(arquivo);
  });
}

async function carregarExtras() {
  const [{ data: regras }, { data: cfg }] = await Promise.all([
    supabase.from("regras_bloqueio").select("*"),
    supabase.from("configuracoes").select("valor").eq("chave", "dia_pedido_avulso").maybeSingle()
  ]);
  regrasCache = regras || [];
  diaLiberado = cfg?.valor ?? null;
}

function baixarArquivo(nome, conteudoDataUrl) {
  const a = document.createElement("a");
  a.href = conteudoDataUrl;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* =========================================================
   DROPDOWNS CUSTOMIZADOS
   ========================================================= */
function toggleDropdown(id) {
  document.querySelectorAll(".custom-dropdown").forEach(drop => {
    const outroId = drop.id.replace("dropdown-", "");
    if (outroId !== id) {
      const l = $("lista-" + outroId);
      const s = drop.querySelector(".seta");
      if (l) l.classList.add("hidden");
      if (s) s.classList.remove("girada");
    }
  });
  const lista = $("lista-" + id);
  const seta = $("dropdown-" + id)?.querySelector(".seta");
  if (lista) lista.classList.toggle("hidden");
  if (seta) seta.classList.toggle("girada");
}

document.addEventListener("click", e => {
  document.querySelectorAll(".custom-dropdown").forEach(drop => {
    if (!drop.contains(e.target)) {
      const id = drop.id.replace("dropdown-", "");
      const l = $("lista-" + id);
      const s = drop.querySelector(".seta");
      if (l) l.classList.add("hidden");
      if (s) s.classList.remove("girada");
    }
  });
});

function preencherDropdown(id, opcoes, valorAtual, placeholder) {
  const ul = $("opcoes-" + id);
  if (!ul) return;
  ul.innerHTML = "";
  opcoes.forEach(op => {
    const li = document.createElement("li");
    li.innerText = op.texto;
    li.setAttribute("data-value", op.valor);
    const selecionado = String(op.valor) === String(valorAtual ?? "");
    li.className = "px-3 py-2 hover:bg-blue-50 cursor-pointer border-b border-slate-50" +
      (selecionado ? " bg-blue-50 text-blue-700" : "");
    li.addEventListener("click", () => {
      $("texto-" + id).innerText = op.texto;
      $("input-" + id).value = op.valor;
      $("lista-" + id).classList.add("hidden");
      $("dropdown-" + id)?.querySelector(".seta")?.classList.remove("girada");
      $("input-" + id).dispatchEvent(new Event("change", { bubbles: true }));
    });
    ul.appendChild(li);
  });
  const atual = opcoes.find(o => String(o.valor) === String(valorAtual ?? ""));
  if (atual) {
    $("texto-" + id).innerText = atual.texto;
    $("input-" + id).value = atual.valor;
  } else {
    $("texto-" + id).innerText = placeholder || "— Selecione —";
    $("input-" + id).value = "";
  }
}

async function carregarFiliais() {
  const { data } = await supabase.from("filiais").select("*").order("id");
  filiais = data || [];
  renderizarDropdownCadastro();
  renderizarDropdownsVenda();
}

function renderizarDropdownCadastro() {
  preencherDropdown(
    "cad-filial",
    filiais.map(f => ({ valor: f.id, texto: f.nome })),   // ⬅ vindo do Supabase
    $("input-cad-filial").value,
    "— Selecione sua filial —"
  );
}

/* =========================================================
   CADASTRO
   ========================================================= */
function abrirModalCadastro() {
  $("form-cadastro").reset();
  $("input-cad-filial").value = "";
  renderizarDropdownCadastro();
  $("msg-cadastro").classList.add("hidden");
  $("modal-cadastro").classList.remove("hidden");
}

function fecharModalCadastro() {
  $("modal-cadastro").classList.add("hidden");
}

$("form-cadastro").addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("msg-cadastro");
  const btn = $("btn-cadastrar");

  const nome = $("cad-nome").value.trim();
  const email = $("cad-email").value.trim().toLowerCase();
  const filial = $("input-cad-filial").value;
  const senha = $("cad-senha").value;

  if (!filial) {
    msg.innerText = "Selecione sua filial.";
    msg.className = "text-xs font-medium text-red-600";
    msg.classList.remove("hidden");
    return;
  }

  btn.disabled = true;
  btn.innerText = "Enviando...";

  try {
    const { data, error } = await supabase.auth.signUp({ email, password: senha });
    if (error) throw error;

    const { error: erroPerfil } = await supabase.from("usuarios").insert([{
      id: data.user.id,
      nome,
      filial,
      email,
      role: "pendente"
    }]);
    if (erroPerfil) throw erroPerfil;

    msg.innerText = "Cadastro enviado! Você poderá entrar assim que o administrador aprovar.";
    msg.className = "text-xs font-medium text-green-600";
    msg.classList.remove("hidden");
    $("form-cadastro").reset();
    $("input-cad-filial").value = "";
    renderizarDropdownCadastro();

    setTimeout(fecharModalCadastro, 2500);
  } catch (err) {
    msg.innerText = err.message.includes("already registered")
      ? "Este e-mail já está cadastrado."
      : "Erro no cadastro: " + err.message;
    msg.className = "text-xs font-medium text-red-600";
    msg.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerText = "Enviar cadastro para aprovação";
  }
});

/* =========================================================
   LOGIN / LOGOUT
   ========================================================= */
$("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("login-botao");
  btn.innerText = "Verificando...";
  btn.disabled = true;
  $("login-erro").classList.add("hidden");

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-senha").value
    });
    if (error) throw error;

    const { data: perfil, error: erroPerfil } = await supabase
      .from("usuarios")
      .select("*")
      .eq("id", data.user.id)
      .single();

    if (erroPerfil || !perfil) throw new Error("Perfil não encontrado. Contate o administrador.");
    if (perfil.role === "pendente") throw new Error("Seu cadastro ainda está aguardando aprovação do administrador.");

    usuarioAtual = perfil;
    await entrarNoApp();
  } catch (err) {
    await supabase.auth.signOut();
    $("login-erro").innerText = err.message.includes("Invalid login")
      ? "E-mail ou senha incorretos."
      : err.message;
    $("login-erro").classList.remove("hidden");
  } finally {
    btn.innerText = "Entrar";
    btn.disabled = false;
  }
});

async function entrarNoApp() {
  $("perfil-nome").innerText = usuarioAtual.nome;
  $("perfil-email").innerText = `${usuarioAtual.email} · ${usuarioAtual.role}`;
  $("perfil-iniciais").innerText = usuarioAtual.nome.substring(0, 2).toUpperCase();
  $("topbar-loja").innerText = nomeLoja(usuarioAtual.filial);

  $("btn-aba-sugestoes").classList.toggle("hidden", !ehGestor());

  $("tela-login").classList.add("hidden");
  $("app").classList.remove("hidden");

  await carregarFiliais();
  await atualizarTudo();
  iniciarRealtime();
  mudarAba("inicio");
}

async function sairDoSistema() {
  await supabase.auth.signOut();
  if (canalRealtime) {
    supabase.removeChannel(canalRealtime);
    canalRealtime = null; // ⬅ permite reconectar no próximo login
  }
  usuarioAtual = null;
  $("app").classList.add("hidden");
  $("tela-login").classList.remove("hidden");
  $("login-senha").value = "";
}

// Sessão persistida pelo Supabase — entra direto se já estiver logado
(async () => {
  await carregarFiliais(); // filiais têm leitura pública (necessário p/ o cadastro)
  await carregarExtras();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  const { data: perfil } = await supabase.from("usuarios").select("*").eq("id", session.user.id).single();
  if (perfil && perfil.role !== "pendente") {
    usuarioAtual = perfil;
    await entrarNoApp();
  }
})();

/* =========================================================
   SIDEBAR / ABAS
   ========================================================= */
function toggleSidebarDesktop() {
  const sidebar = $("sidebar");
  const main = $("main-content");
  const icon = $("toggle-icon");
  sidebar.classList.toggle("sidebar-collapsed");
  main.classList.toggle("sidebar-collapsed-margin");
  if (sidebar.classList.contains("sidebar-collapsed")) {
    icon.classList.replace("fa-chevron-left", "fa-chevron-right");
  } else {
    icon.classList.replace("fa-chevron-right", "fa-chevron-left");
  }
}

function toggleMobileMenu() {
  $("sidebar").classList.toggle("-translate-x-full");
  $("sidebar-backdrop").classList.toggle("hidden");
}

function mudarAba(aba) {
  // ⬅ Vendedor não acessa Sugestões — redireciona para Pedidos Avulsos
  if (aba === "sugestoes" && !ehGestor()) aba = "vendas";

  ["inicio", "sugestoes", "vendas"].forEach(s => {
    $("secao-" + s).classList.add("hidden");
    const btn = $("btn-aba-" + s);
    btn.classList.remove("border-blue-400", "bg-slate-800", "text-slate-200");
    btn.classList.add("border-transparent", "text-slate-400");
  });
  $("secao-" + aba).classList.remove("hidden");
  const btnAtivo = $("btn-aba-" + aba);
  btnAtivo.classList.remove("border-transparent", "text-slate-400");
  btnAtivo.classList.add("border-blue-400", "bg-slate-800", "text-slate-200");

  const titulos = {
    inicio:    ["Início", "Visão geral das suas transferências."],
    sugestoes: ["Sugestões de Transferência", "Disponível em breve."],
    vendas:    ["Pedidos Avulsos", "Envie pedidos avulsos com evidências e acompanhe o retorno do admin."]
  };
  $("titulo-pagina").innerText = titulos[aba][0];
  $("subtitulo-pagina").innerText = titulos[aba][1];

  if (window.innerWidth < 768) toggleMobileMenu();
}

async function atualizarTudo(mostrarAviso = false) {
  await carregarTransferencias();
  await carregarVendasSupabase();
  await carregarExtras();
  renderizarDiaAvulso();
  renderizarFiltrosLoja();
  renderizarInicio();
  renderizarTransferencias();
  renderizarVendas();
  if (mostrarAviso) mostrarToast("Dados atualizados.");
}

/* =========================================================
   DADOS — SUPABASE
   ========================================================= */
async function carregarTransferencias() {
  if (!usuarioAtual || !ehGestor()) return; // ⬅ só gestor/supervisor carregam sugestões
  const { data } = await supabase
    .from("sugestoes")
    .select("*")
    .eq("filial", usuarioAtual.filial)
    .order("data_envio", { ascending: false });
  transferenciasCache = {};
  (data || []).forEach(t => { transferenciasCache[t.id] = t; });
  window.transferenciasCache = transferenciasCache;
}

/* ---------- Realtime ---------- */
let canalRealtime = null;

function iniciarRealtime() {
  if (canalRealtime) return;
  canalRealtime = supabase.channel("loja-realtime-" + usuarioAtual.filial);

  // Sugestões: só gestor/supervisor
  if (ehGestor()) {
    canalRealtime.on("postgres_changes",
      { event: "*", schema: "public", table: "sugestoes", filter: `filial=eq.${usuarioAtual.filial}` },
      () => {
        carregarTransferencias().then(() => {
          renderizarInicio();
          renderizarTransferencias();
        });
      });
  }

  canalRealtime
    .on("postgres_changes",
      { event: "*", schema: "public", table: "filiais" },
      () => {
        carregarFiliais();
      })
    .on("postgres_changes",
      { event: "*", schema: "public", table: "vendas_casadas" },
      () => {
        carregarVendasSupabase().then(() => {
          renderizarVendas();
          renderizarInicio();
        });
      })
    .on("postgres_changes",
      { event: "*", schema: "public", table: "autorizacoes_venda", filter: `usuario_id=eq.${usuarioAtual.id}` },
      () => {
        carregarVendasSupabase().then(renderizarVendas);
      })
    .on("postgres_changes",
      { event: "*", schema: "public", table: "configuracoes" },
      () => {
        carregarExtras().then(renderizarDiaAvulso);
      })
    .on("postgres_changes",
      { event: "*", schema: "public", table: "regras_bloqueio" },
      () => {
        carregarExtras();
      })
    .subscribe();
}

/* =========================================================
   ABA: INÍCIO
   ========================================================= */
function statusSugestaoAtual() {
  const f = filiais.find(x => x.id === usuarioAtual?.filial);
  const janelaDias = f?.periodicidade === "quinzenal" ? 15 : 7;
  const limite = new Date();
  limite.setDate(limite.getDate() - janelaDias);

  const recentes = Object.values(transferenciasCache)
    .filter(t => new Date(t.data_envio) >= limite)
    .sort((a, b) => new Date(b.data_envio) - new Date(a.data_envio));

  if (recentes.length === 0) return { txt: "Nenhuma sugestão enviada no período", cor: "red" };
  const t = recentes[0];
  if (t.status === "pedido")     return { txt: "Pedido feito", cor: "green" };
  if (t.status === "respondido") return { txt: "Sua resposta foi devolvida — aguardando pedido", cor: "sky" };
  return { txt: "Nova sugestão aguardando sua resposta", cor: "amber" };
}

async function renderizarInicio() {
  const vendas = Object.values(vendasCache);

  // ⬅ Início do VENDEDOR: só pedidos avulsos
  if (!ehGestor()) {
    const pendentes = vendas.filter(v => v.status === "pendente").length;
    const aguardandoAut = vendas.filter(v => v.status === "aguardando_autorizacoes").length;
    const aprovadas = vendas.filter(v => v.status === "aprovado").length;
    const negadas = vendas.filter(v => v.status === "negado" || v.status === "negado_permanente").length;

    const card = (numero, rotulo, cor, icone) => `
      <div class="bg-white border border-slate-200 rounded-sm p-5 border-t-4 ${cor}">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[11px] font-bold text-slate-400 uppercase tracking-wide">${rotulo}</span>
          <i class="fas ${icone} text-slate-300"></i>
        </div>
        <span class="text-3xl font-extrabold text-slate-900">${numero}</span>
      </div>`;

    $("cards-resumo").innerHTML =
      card(pendentes, "aguardando admin", "border-t-indigo-400", "fa-hourglass-half") +
      card(aguardandoAut, "aguardando autorizações", "border-t-amber-400", "fa-user-shield") +
      card(aprovadas, "aprovados", "border-t-green-500", "fa-check-circle") +
      card(negadas, "negados", "border-t-red-400", "fa-times-circle");

    renderizarAtividade([], vendas);
    return;
  }

  const transf = Object.values(transferenciasCache);

  const novas = transf.filter(t => t.status === "sugerido").length;
  const devolvidas = transf.filter(t => t.status === "respondido").length;
  const pedidos = transf.filter(t => t.status === "pedido").length;
  const vendasPendentes = vendas.filter(v => v.status === "pendente").length;

  const card = (numero, rotulo, cor, icone) => `
    <div class="bg-white border border-slate-200 rounded-sm p-5 border-t-4 ${cor}">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] font-bold text-slate-400 uppercase tracking-wide">${rotulo}</span>
        <i class="fas ${icone} text-slate-300"></i>
      </div>
      <span class="text-3xl font-extrabold text-slate-900">${numero}</span>
    </div>`;

  $("cards-resumo").innerHTML =
    card(novas, "novas sugestões", "border-t-amber-400", "fa-inbox") +
    card(devolvidas, "aguardando pedido", "border-t-sky-400", "fa-paper-plane") +
    card(pedidos, "pedidos registrados", "border-t-green-500", "fa-check-circle") +
    card(vendasPendentes, "pedidos avulsos pendentes", "border-t-indigo-400", "fa-box-open");

  renderizarMinhaAgenda();
  renderizarAtividade(transf, vendas);
}

function renderizarMinhaAgenda() {
  const f = filiais.find(x => x.id === usuarioAtual?.filial);
  if (!f) return;

  const st = statusSugestaoAtual();
  const cores = {
    red:   "text-red-600 bg-red-50 border-red-200",
    amber: "text-amber-700 bg-amber-50 border-amber-200",
    sky:   "text-sky-700 bg-sky-50 border-sky-200",
    green: "text-green-700 bg-green-50 border-green-200"
  };

  const diaLabel = f.dia_semana !== null && f.dia_semana !== undefined
    ? DIAS_SEMANA.find(d => d.n === f.dia_semana)?.label
    : null;

  $("minha-agenda").innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded bg-blue-100 text-blue-700 flex items-center justify-center">
          <i class="fas fa-calendar-day text-lg"></i>
        </div>
        <div>
          <p class="text-sm font-bold text-slate-800">${escapeHtml(nomeLoja(f.id))}</p>
          <p class="text-xs text-slate-400">
            ${f.periodicidade === "quinzenal" ? "Sugestões quinzenais" : "Sugestões semanais"}
            ${diaLabel ? ` · todo(a) <strong class="text-slate-600">${diaLabel}</strong>` : ' · <span class="text-amber-600 font-bold">dia não definido pelo admin</span>'}
          </p>
        </div>
      </div>
      <span class="text-[11px] font-bold px-3 py-1.5 rounded-sm border ${cores[st.cor]} sm:ml-auto">${st.txt}</span>
    </div>`;
}

function renderizarAtividade(transf, vendas) {
  const eventos = [
    ...transf.map(t => ({ data: t.data_envio, tipo: "transf", item: t })),
    ...vendas.map(v => ({ data: v.data_envio, tipo: "venda", item: v }))
  ].sort((a, b) => new Date(b.data) - new Date(a.data)).slice(0, 6);

  if (eventos.length === 0) {
    $("atividade-recente").innerHTML =
      '<p class="py-8 text-center text-slate-400 italic text-sm">Nenhuma atividade registrada ainda.</p>';
    return;
  }

  $("atividade-recente").innerHTML = eventos.map(ev => {
    if (ev.tipo === "transf") {
      const t = ev.item;
      const statusTxt =
        t.status === "pedido" ? "Pedido feito" :
        t.status === "respondido" ? "Você devolveu a planilha" : "Nova sugestão recebida";
      const corTexto =
        t.status === "pedido" ? "text-green-700" :
        t.status === "respondido" ? "text-sky-700" : "text-amber-700";
      const corBorda =
        t.status === "pedido" ? "border-l-green-600" :
        t.status === "respondido" ? "border-l-sky-500" : "border-l-amber-400";
      return `
        <div class="flex justify-between items-center gap-3 py-3 border-b border-slate-100 last:border-0 flex-wrap">
          <div>
            <span class="text-sm font-bold text-slate-800">Sugestão de transferência</span>
            <span class="text-[10px] font-bold text-slate-400 uppercase ml-2">recebida</span>
            <span class="text-xs text-slate-400 ml-2">${dataHoraBr(t.data_envio)}</span>
          </div>
          <span class="text-[11px] font-bold uppercase tracking-wide ${corTexto} border-l-4 ${corBorda} pl-2">${statusTxt}</span>
        </div>`;
    }
    const v = ev.item;
    const txtStatus =
      v.status === "aprovado" ? "Aprovado" :
      v.status === "negado" ? "Negado" :
      v.status === "negado_permanente" ? "Negado permanente" :
      v.status === "aguardando_autorizacoes" ? "Aguardando autorizações" :
      "Aguardando retorno do admin";
    const corStatus =
      v.status === "aprovado" ? "text-green-700 border-l-green-600" :
      v.status === "negado" ? "text-red-600 border-l-red-500" :
      v.status === "negado_permanente" ? "text-red-800 border-l-red-700" :
      v.status === "aguardando_autorizacoes" ? "text-amber-700 border-l-amber-400" :
      "text-indigo-700 border-l-indigo-400";
    return `
      <div class="flex justify-between items-center gap-3 py-3 border-b border-slate-100 last:border-0 flex-wrap">
        <div>
          <span class="text-sm font-bold text-slate-800">Pedido avulso ${nomeLoja(v.filial_saida)} → ${nomeLoja(v.filial_destino)}</span>
          <span class="text-[10px] font-bold text-slate-400 uppercase ml-2">enviado</span>
          <span class="text-xs text-slate-400 ml-2">${dataHoraBr(v.data_envio)}</span>
        </div>
        <span class="text-[11px] font-bold uppercase tracking-wide ${corStatus} border-l-4 pl-2">${txtStatus}</span>
      </div>`;
  }).join("");
}

/* =========================================================
   ABA: SUGESTÕES (em breve — código preservado)
   ========================================================= */
let filtroStatusSug = "";

function renderizarFiltrosLoja() {
  preencherDropdown("filtro-status-sug", [
    { valor: "", texto: "Todas as situações" },
    { valor: "sugerido", texto: "Novas (aguardando sua resposta)" },
    { valor: "respondido", texto: "Respondidas (aguardando pedido)" },
    { valor: "pedido", texto: "Finalizadas" }
  ], filtroStatusSug);
  preencherDropdown("filtro-status-venda", [
    { valor: "", texto: "Todas as situações" },
    { valor: "pendente", texto: "Aguardando retorno do admin" },
    { valor: "aguardando_autorizacoes", texto: "Aguardando autorizações" },
    { valor: "aprovado", texto: "Aprovados" },
    { valor: "negado", texto: "Negados" },
    { valor: "negado_permanente", texto: "Negados permanentemente" }
  ], filtroStatusVenda);
}

let filtroStatusVenda = "";

document.addEventListener("change", e => {
  const alvo = e.target;
  if (!alvo.id) return;
  if (alvo.id === "input-filtro-status-sug") {
    filtroStatusSug = alvo.value;
    renderizarTransferencias();
  } else if (alvo.id === "input-filtro-status-venda") {
    filtroStatusVenda = alvo.value;
    renderizarVendas();
  }
});

/* ⬇ Helpers reutilizáveis (badges + blocos do modal de detalhes) */
function badgeTransfLoja(t) {
  if (t.status === "pedido")
    return `<span class="text-[11px] font-bold text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-check-circle mr-1"></i> Finalizado</span>`;
  if (t.status === "respondido")
    return `<span class="text-[11px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-paper-plane mr-1"></i> Respondida</span>`;
  return `<span class="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-inbox mr-1"></i> Nova sugestão</span>`;
}

function badgeVendaLoja(v) {
  if (v.status === "aprovado")
    return `<span class="text-[11px] font-bold text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-check-circle mr-1"></i> Aprovado</span>`;
  if (v.status === "negado_permanente")
    return `<span class="text-[11px] font-bold text-red-800 bg-red-100 border border-red-300 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-ban mr-1"></i> Negado permanente</span>`;
  if (v.status === "negado")
    return `<span class="text-[11px] font-bold text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-times-circle mr-1"></i> Negado</span>`;
  if (v.status === "aguardando_autorizacoes")
    return `<span class="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-user-shield mr-1"></i> Aguardando autorizações</span>`;
  return `<span class="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-1 rounded-sm whitespace-nowrap"><i class="fas fa-hourglass-half mr-1"></i> Aguardando retorno</span>`;
}

function blocoPedidos(pedidos) {
  return `<div class="rounded-sm border border-green-200 bg-green-50 px-2.5 py-2 flex flex-col gap-0.5">
    ${pedidos.map(p => `<p class="text-[11px] text-green-800"><strong class="font-mono">${escapeHtml(p.numero)}</strong>${p.obs ? ` <span class="text-green-700">— ${escapeHtml(p.obs)}</span>` : ""}</p>`).join("")}
  </div>`;
}

function linhaDetalhe(rotulo, html) {
  return `<div><span class="text-slate-400 font-bold uppercase text-[9px] tracking-wide block mb-0.5">${rotulo}</span><div class="text-[12px] text-slate-600">${html}</div></div>`;
}
function blocoFase(titulo, linhas) {
  const conteudo = linhas.filter(Boolean).join("");
  if (!conteudo) return "";
  return `<div>
    <span class="text-slate-400 font-bold uppercase text-[9px] tracking-wide block mb-1">${titulo}</span>
    <div class="border border-slate-200 bg-slate-50/60 rounded-sm px-3 py-2 flex flex-col gap-1">${conteudo}</div>
  </div>`;
}

let detalheAbertoId = null;
let detalheAbertoTipo = null; // "transf" | "venda"

function fecharModalDetalhe() {
  $("modal-detalhe").classList.add("hidden");
  detalheAbertoId = null;
  detalheAbertoTipo = null;
}

/* ⬅ Re-renderiza o modal de detalhes que está aberto (ex.: após baixar/responder) */
function atualizarModalDetalhe() {
  if (!detalheAbertoId) return;
  if (detalheAbertoTipo === "transf") abrirModalDetalheTransfLoja(detalheAbertoId);
  else abrirModalDetalheVendaLoja(detalheAbertoId);
}

function renderizarTransferencias() {
  const container = $("lista-transferencias");
  if (!container) return;
  let lista = Object.values(transferenciasCache)
    .sort((a, b) => new Date(b.data_envio) - new Date(a.data_envio));
  if (filtroStatusSug) lista = lista.filter(t => t.status === filtroStatusSug);

  if (lista.length === 0) {
    container.innerHTML = `<p class="py-8 text-center text-slate-400 italic text-sm">${filtroStatusSug ? "Nenhuma sugestão nesta situação." : "Nenhuma sugestão recebida no momento."}</p>`;
    return;
  }

  container.innerHTML = lista.map(t => {
    const resumo = [
      `enviada ${dataHoraBr(t.data_envio)}`,
      t.resposta_data ? `· devolvida ${dataHoraBr(t.resposta_data)}` : ""
    ].join(" ");
    const corBorda =
      t.status === "pedido" ? "border-l-green-600" :
      t.status === "respondido" ? "border-l-sky-500" : "border-l-amber-400";

    return `
      <div class="bg-white border border-slate-200 border-l-4 ${corBorda} rounded-sm p-3.5 transition-colors hover:bg-slate-50">
        <div class="flex justify-between items-center gap-2 flex-wrap">
          <div class="flex items-baseline gap-2 flex-wrap min-w-0">
            <span class="font-bold text-sm text-slate-800">Sugestão</span>
            <span class="text-[11px] text-slate-400">${resumo}</span>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${badgeTransfLoja(t)}
            <button onclick="abrirModalDetalheTransfLoja('${t.id}')" class="border border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-blue-700 px-3 py-1.5 rounded-sm text-[11px] font-bold uppercase tracking-wide transition-colors whitespace-nowrap">
              <i class="fas fa-search mr-1"></i> Ver detalhes
            </button>
          </div>
        </div>
      </div>`;
  }).join("");
}

/* ⬇ Modal de detalhes da sugestão (loja) */
function abrirModalDetalheTransfLoja(id) {
  const t = transferenciasCache[id];
  if (!t) return;
  detalheAbertoId = id;
  detalheAbertoTipo = "transf";
  const pedidosT = Array.isArray(t.pedidos) ? t.pedidos : [];

  let rodape = "";
  let acoes = "";
  if (t.status === "sugerido") {
    acoes = t.baixado_pela_loja
      ? `<button onclick="baixarTransfPorId('${t.id}', 'sugestao')" class="border border-slate-300 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wide transition-colors whitespace-nowrap"><i class="fas fa-download mr-1"></i> Baixar novamente</button>
         <button onclick="abrirModalResposta('${t.id}')" class="bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wide transition-colors whitespace-nowrap"><i class="fas fa-paper-plane mr-1"></i> Enviar planilha respondida</button>`
      : `<button onclick="baixarTransfPorId('${t.id}', 'sugestao')" class="bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wide transition-colors whitespace-nowrap"><i class="fas fa-download mr-1"></i> 1º Baixar planilha enviada</button>
         <button disabled class="bg-slate-200 text-slate-400 px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wide cursor-not-allowed whitespace-nowrap">Enviar resposta</button>
         <span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1.5 rounded-sm mr-auto uppercase"><i class="fas fa-lock mr-1"></i> Envio liberado após o download</span>`;
  }
  if (t.status === "respondido") {
    acoes = `<span class="text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-1.5 rounded-sm mr-auto uppercase"><i class="fas fa-hourglass-half mr-1"></i> Aguardando o admin registrar o pedido</span>`;
  }
  if (t.status === "pedido") {
    rodape = `<p class="text-[11px] text-slate-500"><strong class="text-green-700">Concluído em:</strong> ${dataHoraBr(t.data_pedido)} &nbsp;·&nbsp; <strong>por:</strong> ${escapeHtml(t.pedido_por || "Admin")}</p>`;
  }

  $("modal-detalhe-conteudo").innerHTML = `
    <h2 class="text-lg font-bold text-slate-800 mb-1">Sugestão de transferência</h2>
    <div class="flex items-center gap-2 mb-3 flex-wrap">${badgeTransfLoja(t)}</div>
    <div class="flex flex-col gap-3">
      ${blocoFase("Sugestão enviada", [
        `<p class="text-[11px] text-slate-500"><i class="fas fa-paperclip text-slate-300 mr-1"></i><a href="#" onclick="event.preventDefault(); baixarTransfPorId('${t.id}', 'sugestao')" class="text-blue-700 font-bold">${escapeHtml(t.arquivo_nome)}</a> <span class="text-slate-400">· ${dataHoraBr(t.data_envio)} por ${escapeHtml(t.enviado_por || "Admin")}</span></p>`,
        t.obs_sugestao ? `<p class="text-[11px] text-slate-500"><i class="fas fa-comment-dots text-blue-300 mr-1"></i>${escapeHtml(t.obs_sugestao)}</p>` : ""
      ])}
      ${blocoFase("Sugestão ajustada", [
        t.resposta_arquivo_nome
          ? `<p class="text-[11px] text-slate-500"><i class="fas fa-paperclip text-slate-300 mr-1"></i><a href="#" onclick="event.preventDefault(); baixarTransfPorId('${t.id}', 'resposta')" class="text-blue-700 font-bold">${escapeHtml(t.resposta_arquivo_nome)}</a> <span class="text-slate-400">· ${dataHoraBr(t.resposta_data)} por ${escapeHtml(t.respondido_por || "você")}</span></p>`
          : `<p class="text-[11px] text-slate-400 italic">Ainda não devolvida</p>`,
        t.resposta_obs ? `<p class="text-[11px] text-slate-500"><i class="fas fa-comment-dots text-sky-400 mr-1"></i>${escapeHtml(t.resposta_obs)}</p>` : ""
      ])}
      ${pedidosT.length ? `<div><span class="text-slate-400 font-bold uppercase text-[9px] tracking-wide block mb-1">Pedidos registrados</span>${blocoPedidos(pedidosT)}</div>` : ""}
      ${rodape}
    </div>
    ${acoes ? `<div class="flex justify-end items-center gap-2 pt-4 flex-wrap">${acoes}</div>` : ""}`;
  $("modal-detalhe").classList.remove("hidden");
}

async function baixarTransfPorId(id, tipo) {
  const t = transferenciasCache[id];
  if (!t) return;
  if (tipo === "sugestao" && t.arquivo_conteudo) {
    baixarArquivo(t.arquivo_nome, t.arquivo_conteudo);
    if (!t.baixado_pela_loja) {
      const { error } = await supabase.from("sugestoes")
        .update({ baixado_pela_loja: true })
        .eq("id", id);
      if (!error) {
        t.baixado_pela_loja = true;
        renderizarTransferencias();
        atualizarModalDetalhe();
        mostrarToast("Planilha baixada! Agora você pode enviar sua resposta.");
      }
    }
  }
  if (tipo === "resposta" && t.resposta_arquivo_conteudo) {
    baixarArquivo(t.resposta_arquivo_nome, t.resposta_arquivo_conteudo);
  }
}

/* ----- Modal: enviar planilha respondida ----- */
function abrirModalResposta(id) {
  const t = transferenciasCache[id];
  if (!t) return;
  if (!t.baixado_pela_loja) {
    mostrarToast("Você precisa baixar a planilha enviada antes de responder.");
    return;
  }
  transferenciaEmEdicao = id;
  $("modal-resposta-info").innerText =
    `Você já baixou "${t.arquivo_nome}". Faça as alterações e envie a planilha de volta.`;
  $("resposta-arquivo").value = "";
  $("resposta-obs").value = "";
  $("msg-modal-resposta").classList.add("hidden");
  $("modal-resposta").classList.remove("hidden");
}

function fecharModalResposta() {
  $("modal-resposta").classList.add("hidden");
  transferenciaEmEdicao = null;
}

async function confirmarResposta() {
  const btn = $("btn-confirmar-resposta");
  btn.disabled = true;
  btn.innerText = "Enviando...";
  const idRespondida = transferenciaEmEdicao;
  try {
    const arquivo = await lerArquivo($("resposta-arquivo"));
    const t = transferenciasCache[transferenciaEmEdicao];
    if (!t) throw new Error("Sugestão não encontrada.");
    if (!t.baixado_pela_loja) throw new Error("Você precisa baixar a planilha enviada antes de responder.");

    const { error } = await supabase.from("sugestoes").update({
      resposta_arquivo_nome: arquivo.nome,
      resposta_arquivo_conteudo: arquivo.conteudo,
      resposta_obs: $("resposta-obs").value.trim() || null,
      respondido_por: usuarioAtual.nome,
      resposta_data: new Date().toISOString(),
      status: "respondido"
    }).eq("id", transferenciaEmEdicao);
    if (error) throw error;

    await carregarTransferencias();
    fecharModalResposta();
    renderizarInicio();
    renderizarTransferencias();
    detalheAbertoId = idRespondida;
    detalheAbertoTipo = "transf";
    atualizarModalDetalhe();
    mostrarToast("Planilha respondida enviada ao admin.");
  } catch (err) {
    $("msg-modal-resposta").innerText = err.message;
    $("msg-modal-resposta").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerText = "Enviar planilha";
  }
}

/* =========================================================
   ABA: PEDIDOS AVULSOS
   ========================================================= */
function renderizarDropdownsVenda() {
  preencherDropdown(
    "venda-saida",
    filiais.map(f => ({ valor: f.id, texto: f.nome })),   // ⬅ vindo do Supabase
    usuarioAtual?.filial || null,
    "— Selecione —"
  );
  preencherDropdown(
    "venda-destino",
    filiais.map(f => ({ valor: f.id, texto: f.nome })),   // ⬅ inclui a PRÓPRIA filial
    "",
    "— Selecione —"
  );
}

/* ⬇ Dia liberado para pedido avulso */
function proximoDiaInfo() {
  if (!diaLiberado) return null;
  const alvo = parseInt(diaLiberado);
  const hoje = new Date();
  const diff = (alvo - hoje.getDay() + 7) % 7;
  const prox = new Date(hoje); prox.setDate(hoje.getDate() + diff);
  return {
    hoje: diff === 0,
    label: DIAS_SEMANA.find(d => d.n === alvo)?.label || "",
    dataTxt: prox.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
  };
}

function renderizarDiaAvulso() {
  const card = $("card-dia-avulso");
  const btn = $("btn-novo-avulso");
  const info = proximoDiaInfo();
  if (card) {
    if (!info) {
      card.classList.add("hidden");
    } else {
      card.classList.remove("hidden");
      card.innerHTML = info.hoje
        ? `<div class="flex items-center gap-3"><div class="w-10 h-10 rounded bg-green-100 text-green-700 flex items-center justify-center flex-shrink-0"><i class="fas fa-calendar-check"></i></div><div><p class="text-sm font-bold text-slate-800">Hoje é dia de pedido avulso!</p><p class="text-xs text-slate-400">Você pode registrar seus pedidos avulsos hoje.</p></div></div>`
        : `<div class="flex items-center gap-3"><div class="w-10 h-10 rounded bg-blue-100 text-blue-700 flex items-center justify-center flex-shrink-0"><i class="fas fa-calendar-day"></i></div><div><p class="text-sm font-bold text-slate-800">Próximo dia para pedido avulso: <span class="text-blue-700">${info.label}, ${info.dataTxt}</span></p><p class="text-xs text-slate-400">Organize-se e deixe as evidências prontas com antecedência.</p></div></div>`;
    }
  }
  if (btn) {
    const liberado = !info || info.hoje;
    btn.disabled = !liberado;
    btn.classList.toggle("opacity-40", !liberado);
    btn.classList.toggle("cursor-not-allowed", !liberado);
  }
}

/* ⬇ Evidências gerenciadas (adicionar/remover antes do envio) */
const evidenciasSelecionadas = { venda: [], ajuste: [] };

function adicionarEvidencia(input, listaId, chave) {
  const arq = input.files[0];
  if (!arq) return;
  if (arq.size > LIMITE_ARQUIVO) { mostrarToast(`"${arq.name}" é muito grande (máx. 500 KB).`); input.value = ""; return; }
  if (evidenciasSelecionadas[chave].some(e => e.nome === arq.name)) { mostrarToast("Esse arquivo já foi adicionado."); input.value = ""; return; }
  evidenciasSelecionadas[chave].push({ nome: arq.name, arquivo: arq });
  input.value = "";
  renderizarEvidenciasSelecionadas(listaId, chave);
}

function removerEvidencia(listaId, chave, nome) {
  evidenciasSelecionadas[chave] = evidenciasSelecionadas[chave].filter(e => e.nome !== nome);
  renderizarEvidenciasSelecionadas(listaId, chave);
}

function renderizarEvidenciasSelecionadas(listaId, chave) {
  const lista = $(listaId);
  if (!lista) return;
  const itens = evidenciasSelecionadas[chave];
  lista.innerHTML = itens.length ? itens.map(e => `
    <div class="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 rounded-sm px-2.5 py-1.5">
      <span class="text-[11px] font-bold text-slate-600 truncate"><i class="fas fa-paperclip text-slate-300 mr-1"></i>${escapeHtml(e.nome)}</span>
      <button type="button" onclick="removerEvidencia('${listaId}', '${chave}', '${escapeHtml(e.nome)}')" class="text-slate-300 hover:text-red-500 transition-colors leading-none text-lg" title="Remover">&times;</button>
    </div>`).join("") : "";
}

/* ⬇ Modal de aviso de regra de bloqueio (central, com OK CIENTE) */
function abrirModalAvisoRegra(msg) {
  $("aviso-regra-texto").innerText = msg;
  $("modal-aviso-regra").classList.remove("hidden");
}
function fecharModalAvisoRegra() {
  $("modal-aviso-regra").classList.add("hidden");
}

/* ⬇ Modal Novo Pedido Avulso */
function abrirModalPedidoAvulso() {
  const info = proximoDiaInfo();
  if (info && !info.hoje) {
    mostrarToast(`Hoje não é dia de pedido avulso. Próximo: ${info.label} (${info.dataTxt}).`);
    return;
  }
  $("form-venda").reset();
  evidenciasSelecionadas.venda = [];
  renderizarEvidenciasSelecionadas("lista-evidencias-venda", "venda");
  renderizarDropdownsVenda();
  $("modal-pedido-avulso").classList.remove("hidden");
}

function fecharModalPedidoAvulso() {
  $("modal-pedido-avulso").classList.add("hidden");
}

$("form-venda").addEventListener("submit", async e => {
  e.preventDefault();
  const saida = $("input-venda-saida").value;
  const destino = $("input-venda-destino").value;

  if (!saida) { mostrarToast("Selecione a filial de saída."); return; }
  if (!destino) { mostrarToast("Selecione a filial de destino."); return; }
  if (saida === destino) { mostrarToast("Filial de saída e destino não podem ser iguais."); return; }

  // ⬅ Dia liberado para pedidos avulsos
  const info = proximoDiaInfo();
  if (info && !info.hoje) {
    mostrarToast(`Hoje não é dia de pedido avulso. Próximo: ${info.label} (${info.dataTxt}).`);
    return;
  }

  // ⬅ Regras de bloqueio de transferência — aviso central com OK CIENTE
  const regra = regrasCache.find(r => r.filial_saida === saida && r.filial_destino === destino);
  if (regra) {
    abrirModalAvisoRegra(`Não pode ocorrer transferências entre essas filiais${regra.motivo ? ": " + regra.motivo : ""}.`);
    return;
  }

  try {
    // ⬅ Múltiplas evidências (lista gerenciada: adicionar/remover)
    const selecionadas = evidenciasSelecionadas.venda;
    if (!selecionadas.length) { mostrarToast("Adicione pelo menos uma evidência."); return; }
    const evidencias = [];
    for (const sel of selecionadas) {
      const conteudo = await lerArquivoBruto(sel.arquivo);
      evidencias.push({ nome: sel.nome, conteudo });
    }
    const { error } = await supabase.from("vendas_casadas").insert([{
      loja_id: usuarioAtual.filial,
      usuario_id: usuarioAtual.id,
      usuario_nome: usuarioAtual.nome,
      filial_saida: saida,
      filial_destino: destino,
      arquivo_nome: evidencias[0].nome,
      arquivo_conteudo: evidencias[0].conteudo,
      evidencias,
      obs: $("venda-obs").value.trim() || null,
      status: "pendente",
      pedidos: []
    }]);
    if (error) throw error;

    $("form-venda").reset();
    fecharModalPedidoAvulso();
    renderizarDropdownsVenda();
    await carregarVendasSupabase();
    renderizarVendas();
    renderizarInicio();
    mostrarToast("Pedido avulso enviado ao admin!");
  } catch (err) {
    mostrarToast("Erro ao enviar: " + err.message);
  }
});

/* ---------- Pedidos avulsos — 100% Supabase ---------- */
let minhasAutorizacoes = [];

async function carregarVendasSupabase() {
  if (!usuarioAtual) return;
  // ⬅ Vendedor vê SÓ os próprios pedidos · gestor/supervisor veem todos da filial
  let query = supabase.from("vendas_casadas").select("*")
    .order("data_envio", { ascending: false });
  query = ehGestor()
    ? query.eq("loja_id", usuarioAtual.filial)
    : query.eq("usuario_id", usuarioAtual.id);
  const { data: vendas } = await query;
  vendasCache = {};
  (vendas || []).forEach(v => { vendasCache[v.id] = v; });
  window.vendasCache = vendasCache;

  // Autorizações pendentes comigo — SÓ gestor/supervisor veem/decidem
  const cardAut = $("card-autorizacoes");
  if (!ehGestor()) {
    minhasAutorizacoes = [];
    if (cardAut) cardAut.classList.add("hidden");
  } else {
    if (cardAut) cardAut.classList.remove("hidden");
    const { data: auts } = await supabase
      .from("autorizacoes_venda")
      .select("*, vendas_casadas(*)")
      .eq("usuario_id", usuarioAtual.id)
      .eq("status", "pendente");
    minhasAutorizacoes = auts || [];
  }
  renderizarAutorizacoesPendentes();
}

function renderizarAutorizacoesPendentes() {
  const container = $("lista-autorizacoes");
  if (!container) return;

  if (minhasAutorizacoes.length === 0) {
    container.innerHTML = '<p class="py-6 text-center text-slate-400 italic text-sm">Nenhuma autorização pendente com você.</p>';
    return;
  }

  container.innerHTML = minhasAutorizacoes.map(a => {
    const v = a.vendas_casadas;
    if (!v) return "";
    return `
      <div class="bg-amber-50 border border-amber-200 border-l-4 border-l-amber-400 rounded-sm p-3.5 transition-colors hover:bg-amber-100/40">
        <div class="flex justify-between items-start gap-2 flex-wrap">
          <span class="text-sm font-bold text-slate-800">Pedido avulso ${nomeLoja(v.filial_saida)} → ${nomeLoja(v.filial_destino)}</span>
          <span class="text-[10px] font-bold text-amber-700 bg-white border border-amber-300 px-2 py-0.5 rounded-sm whitespace-nowrap"><i class="fas fa-user-shield mr-1"></i> Aguardando seu OK</span>
        </div>
        <p class="text-[11px] text-slate-500 mt-1">Solicitada por <strong>${escapeHtml(v.usuario_nome || nomeLoja(v.loja_id))}</strong> · ${dataHoraBr(v.data_envio)}${a.exigido_por ? ` · exigida por ${escapeHtml(a.exigido_por)}` : ""}</p>
        <div class="flex justify-end mt-2">
          <button onclick="abrirModalAutorizacao('${a.id}')" class="bg-amber-600 hover:bg-amber-700 text-white px-3.5 py-1.5 rounded-sm text-[11px] font-bold uppercase tracking-wide transition-colors whitespace-nowrap">
            <i class="fas fa-search mr-1"></i> Ver detalhes e decidir
          </button>
        </div>
      </div>`;
  }).join("");
}

/* =========================================================
   MODAL: DETALHES DA AUTORIZAÇÃO (ver tudo + autorizar/recusar)
   ========================================================= */
let authModalCtx = null;

async function abrirModalAutorizacao(autId) {
  const a = minhasAutorizacoes.find(x => x.id === autId);
  if (!a || !a.vendas_casadas) return;
  const v = a.vendas_casadas;
  authModalCtx = { autId, vendaId: v.id };

  const { data: todas } = await supabase.from("autorizacoes_venda")
    .select("*").eq("venda_id", v.id);

  $("autorizacao-detalhes").innerHTML = `
    <div class="flex items-center gap-2 text-xs font-bold text-slate-600 flex-wrap">
      <span class="bg-slate-100 border border-slate-200 px-2 py-1 rounded-sm"><i class="fas fa-arrow-up mr-1"></i>Saída: ${nomeLoja(v.filial_saida)}</span>
      <i class="fas fa-arrow-right text-slate-300"></i>
      <span class="bg-slate-100 border border-slate-200 px-2 py-1 rounded-sm"><i class="fas fa-arrow-down mr-1"></i>Destino: ${nomeLoja(v.filial_destino)}</span>
    </div>
    <div class="text-xs bg-slate-50 border border-slate-200 rounded-sm p-3 flex flex-col gap-1.5">
      <span><strong class="text-slate-500 uppercase text-[9px] tracking-wide">Solicitante:</strong> ${escapeHtml(v.usuario_nome || nomeLoja(v.loja_id))} (filial ${escapeHtml(v.loja_id)})</span>
      <span><strong class="text-slate-500 uppercase text-[9px] tracking-wide">Enviado em:</strong> ${dataHoraBr(v.data_envio)}</span>
      <span><strong class="text-slate-500 uppercase text-[9px] tracking-wide">Evidências:</strong> ${(Array.isArray(v.evidencias) && v.evidencias.length ? v.evidencias : (v.arquivo_nome ? [{ nome: v.arquivo_nome }] : [])).map((ev, i) => `<a href="#" onclick="event.preventDefault(); baixarEvidenciaVenda('${v.id}', ${i})" class="text-blue-700 font-bold">${escapeHtml(ev.nome)}</a>`).join(" · ") || "—"}</span>
      ${a.exigido_por ? `<span><strong class="text-slate-500 uppercase text-[9px] tracking-wide">Autorização exigida por:</strong> ${escapeHtml(a.exigido_por)} (admin)</span>` : ""}
      ${v.obs ? `<span><strong class="text-slate-500 uppercase text-[9px] tracking-wide">Obs. do solicitante:</strong> ${escapeHtml(v.obs)}</span>` : ""}
    </div>`;

  const statusAut = (x) => {
    if (x.status === "aprovado") return `<span class="text-green-700 font-bold"><i class="fas fa-check-circle mr-1"></i>${escapeHtml(x.usuario_nome)} — autorizou${x.data_resposta ? " em " + dataHoraBr(x.data_resposta) : ""}</span>`;
    if (x.status === "recusado") return `<span class="text-red-600 font-bold"><i class="fas fa-times-circle mr-1"></i>${escapeHtml(x.usuario_nome)} — recusou${x.motivo_recusa ? ": " + escapeHtml(x.motivo_recusa) : ""}</span>`;
    return `<span class="text-amber-700 font-bold"><i class="fas fa-hourglass-half mr-1"></i>${escapeHtml(x.usuario_nome)} — aguardando</span>`;
  };

  $("autorizacao-processo").innerHTML = (todas || []).map(x => `
    <div class="text-xs border border-slate-100 rounded-sm px-2.5 py-1.5 ${x.id === autId ? "bg-amber-50 border-amber-200" : "bg-white"}">${statusAut(x)}</div>`).join("");

  $("input-motivo-recusa").value = "";
  $("msg-modal-autorizacao").classList.add("hidden");
  $("modal-autorizacao").classList.remove("hidden");
}

function fecharModalAutorizacao() {
  $("modal-autorizacao").classList.add("hidden");
  authModalCtx = null;
}

async function confirmarOkAutorizacao() {
  if (!authModalCtx) return;
  const { error } = await supabase.from("autorizacoes_venda")
    .update({ status: "aprovado", data_resposta: new Date().toISOString() })
    .eq("id", authModalCtx.autId);
  if (error) { mostrarToast("Erro: " + error.message); return; }

  const { data: restantes } = await supabase.from("autorizacoes_venda")
    .select("id").eq("venda_id", authModalCtx.vendaId).eq("status", "pendente");

  fecharModalAutorizacao();
  await carregarVendasSupabase();
  renderizarVendas();
  atualizarModalDetalhe();
  mostrarToast(!restantes || restantes.length === 0
    ? "Você autorizou — todos já autorizaram! O admin já pode aprovar."
    : "Autorização registrada. Ainda aguardando outras pessoas.");
}

async function confirmarRecusaAutorizacao() {
  if (!authModalCtx) return;
  const motivo = $("input-motivo-recusa").value.trim();
  if (!motivo) {
    $("msg-modal-autorizacao").innerText = "Escreva a justificativa da recusa.";
    $("msg-modal-autorizacao").classList.remove("hidden");
    return;
  }

  const agora = new Date().toISOString();
  const { error } = await supabase.from("autorizacoes_venda")
    .update({ status: "recusado", motivo_recusa: motivo, data_resposta: agora })
    .eq("id", authModalCtx.autId);
  if (error) { mostrarToast("Erro: " + error.message); return; }

  await supabase.from("vendas_casadas").update({
    status: "negado",
    motivo_negacao: `Autorização recusada por ${usuarioAtual.nome}: ${motivo}`,
    data_resposta: agora
  }).eq("id", authModalCtx.vendaId);

  fecharModalAutorizacao();
  await carregarVendasSupabase();
  renderizarVendas();
  renderizarInicio();
  atualizarModalDetalhe();
  mostrarToast("Autorização recusada. O pedido foi negado com a justificativa.");
}

/* ⬇ Lista RESUMIDA de pedidos avulsos + filtro por situação */
function renderizarVendas() {
  let lista = Object.values(vendasCache)
    .sort((a, b) => new Date(b.data_envio) - new Date(a.data_envio));
  if (filtroStatusVenda) lista = lista.filter(v => v.status === filtroStatusVenda);
  const container = $("lista-vendas");

  if (lista.length === 0) {
    container.innerHTML = `<p class="py-8 text-center text-slate-400 italic text-sm">${filtroStatusVenda ? "Nenhum pedido avulso nesta situação." : "Nenhum pedido avulso enviado."}</p>`;
    return;
  }

  container.innerHTML = lista.map(v => {
    const corBorda =
      v.status === "aprovado" ? "border-l-green-600" :
      v.status === "negado_permanente" ? "border-l-red-700" :
      v.status === "negado" ? "border-l-red-500" :
      v.status === "aguardando_autorizacoes" ? "border-l-amber-400" : "border-l-indigo-400";

    return `
      <div class="bg-white border border-slate-200 border-l-4 ${corBorda} rounded-sm p-3.5 transition-colors hover:bg-slate-50">
        <div class="flex justify-between items-center gap-2 flex-wrap">
          <div class="flex items-baseline gap-2 flex-wrap min-w-0">
            <span class="font-bold text-sm text-slate-800">${nomeLoja(v.filial_saida)} → ${nomeLoja(v.filial_destino)}</span>
            <span class="text-[11px] text-slate-400">${dataHoraBr(v.data_envio)}</span>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${badgeVendaLoja(v)}
            <button onclick="abrirModalDetalheVendaLoja('${v.id}')" class="border border-slate-300 text-slate-600 hover:bg-slate-100 hover:text-blue-700 px-3 py-1.5 rounded-sm text-[11px] font-bold uppercase tracking-wide transition-colors whitespace-nowrap">
              <i class="fas fa-search mr-1"></i> Ver detalhes
            </button>
          </div>
        </div>
      </div>`;
  }).join("");
}

/* ⬇ Modal de detalhes do pedido avulso (loja) */
function abrirModalDetalheVendaLoja(id) {
  const v = vendasCache[id];
  if (!v) return;
  detalheAbertoId = id;
  detalheAbertoTipo = "venda";
  const pedidos = Array.isArray(v.pedidos) ? v.pedidos : [];
  const evidencias = (Array.isArray(v.evidencias) && v.evidencias.length)
    ? v.evidencias
    : (v.arquivo_nome ? [{ nome: v.arquivo_nome, conteudo: v.arquivo_conteudo }] : []);

  // ⬅ BLOCO 1: PEDIDO ENVIADO
  const blocoPedido = blocoFase("Pedido enviado", [
    `<p class="text-[11px] text-slate-500"><strong>Enviado por:</strong> ${escapeHtml(v.usuario_nome || "você")} · ${dataHoraBr(v.data_envio)}</p>`,
    `<div class="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 flex-wrap">
      <span class="bg-white border border-slate-200 px-1.5 py-0.5 rounded-sm">Saída: ${nomeLoja(v.filial_saida)}</span>
      <i class="fas fa-arrow-right text-slate-300 text-[9px]"></i>
      <span class="bg-white border border-slate-200 px-1.5 py-0.5 rounded-sm">Destino: ${nomeLoja(v.filial_destino)}</span>
    </div>`,
    evidencias.length ? `<p class="text-[11px] text-slate-500"><i class="fas fa-paperclip text-slate-300 mr-1"></i>${evidencias.map((ev, i) => `<a href="#" onclick="event.preventDefault(); baixarEvidenciaVenda('${v.id}', ${i})" class="text-blue-700 font-bold">${escapeHtml(ev.nome)}</a>`).join(" · ")}</p>` : "",
    v.obs ? `<p class="text-[11px] text-slate-500"><i class="fas fa-comment-dots text-indigo-300 mr-1"></i>${escapeHtml(v.obs)}</p>` : ""
  ]);

  // ⬅ BLOCO FINAL: RESPOSTA DO ADMIN (sempre por último)
  let blocoResposta = "";
  if (v.status === "aprovado") {
    blocoResposta = `
      <div>
        <span class="text-slate-400 font-bold uppercase text-[9px] tracking-wide block mb-1">Resposta do admin — APROVADO</span>
        <div class="border border-green-200 bg-green-50 rounded-sm px-3 py-2 flex flex-col gap-1">
          ${pedidos.length ? blocoPedidos(pedidos) : `<p class="text-[11px] text-green-700 italic">Sem pedidos registrados.</p>`}
          <p class="text-[11px] text-green-700"><strong>Concluído em:</strong> ${dataHoraBr(v.data_resposta)} &nbsp;·&nbsp; <strong>por:</strong> ${escapeHtml(v.respondido_por || "Admin")}</p>
        </div>
      </div>`;
  }
  if (v.status === "negado" || v.status === "negado_permanente") {
    blocoResposta = `
      <div>
        <span class="text-slate-400 font-bold uppercase text-[9px] tracking-wide block mb-1">Resposta do admin — ${v.status === "negado_permanente" ? "NEGADO DEFINITIVAMENTE" : "NEGADO"}</span>
        <div class="border border-red-200 bg-red-50 rounded-sm px-3 py-2 flex flex-col gap-1">
          ${v.motivo_negacao ? `<p class="text-[11px] text-red-600"><i class="fas fa-ban text-red-300 mr-1"></i><strong>${escapeHtml(v.motivo_negacao)}</strong></p>` : ""}
          <p class="text-[11px] text-red-600"><strong>${v.status === "negado_permanente" ? "Negado definitivamente em:" : "Negado em:"}</strong> ${dataHoraBr(v.data_resposta)} &nbsp;·&nbsp; <strong>por:</strong> ${escapeHtml(v.respondido_por || "Admin")}</p>
        </div>
      </div>`;
  }

  const ajustesHtml = (Array.isArray(v.ajustes) && v.ajustes.length) ? `
    <div>
      <span class="text-slate-400 font-bold uppercase text-[9px] tracking-wide block mb-1">Seus ajustes</span>
      ${v.ajustes.map(a => `
        <div class="border border-slate-200 bg-white rounded-sm px-2.5 py-2 mb-1">
          <p class="text-[11px] text-slate-400">${escapeHtml(a.por)} · ${dataHoraBr(a.data)}</p>
          ${a.obs ? `<p class="text-[11px] text-slate-600"><i class="fas fa-comment-dots text-sky-400 mr-1"></i>${escapeHtml(a.obs)}</p>` : ""}
          ${(a.evidencias || []).map((ev, i) => `<p class="text-[11px] text-slate-500"><i class="fas fa-paperclip text-slate-300 mr-1"></i><a href="#" onclick="event.preventDefault(); baixarEvidenciaAjuste('${v.id}', '${a.data}', ${i})" class="text-blue-700 font-bold">${escapeHtml(ev.nome)}</a></p>`).join("")}
        </div>`).join("")}
    </div>` : "";

  $("modal-detalhe-conteudo").innerHTML = `
    <h2 class="text-lg font-bold text-slate-800 mb-1">Pedido avulso</h2>
    <div class="flex items-center gap-2 mb-3 flex-wrap">${badgeVendaLoja(v)}</div>
    <div class="flex flex-col gap-3">
      ${blocoPedido}
      ${ajustesHtml}
      ${blocoResposta}
    </div>
    ${v.status === "negado" ? `
    <div class="flex justify-end pt-3">
      <button onclick="abrirModalAjuste('${v.id}')" class="bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wide transition-colors whitespace-nowrap">
        <i class="fas fa-reply mr-1"></i> Responder ao admin / ajustar
      </button>
    </div>` : ""}`;
  $("modal-detalhe").classList.remove("hidden");
}

function baixarVendaPorId(id) {
  const v = vendasCache[id];
  if (v?.arquivo_conteudo) baixarArquivo(v.arquivo_nome, v.arquivo_conteudo);
}

function evidenciasDaVenda(v) {
  return (Array.isArray(v.evidencias) && v.evidencias.length)
    ? v.evidencias
    : (v.arquivo_nome ? [{ nome: v.arquivo_nome, conteudo: v.arquivo_conteudo }] : []);
}

function baixarEvidenciaVenda(vendaId, i) {
  const v = vendasCache[vendaId];
  if (!v) return;
  const lista = evidenciasDaVenda(v);
  if (lista[i]) baixarArquivo(lista[i].nome, lista[i].conteudo);
}

function baixarEvidenciaAjuste(vendaId, dataAjuste, i) {
  const v = vendasCache[vendaId];
  if (!v || !Array.isArray(v.ajustes)) return;
  const ajuste = v.ajustes.find(a => a.data === dataAjuste);
  if (ajuste?.evidencias?.[i]) baixarArquivo(ajuste.evidencias[i].nome, ajuste.evidencias[i].conteudo);
}

/* =========================================================
   RESPONDER AO ADMIN (ajuste após negado)
   ========================================================= */
function abrirModalAjuste(id) {
  const v = vendasCache[id];
  if (!v) return;
  ajusteVendaId = id;
  $("modal-ajuste-info").innerText = `Pedido avulso ${nomeLoja(v.filial_saida)} → ${nomeLoja(v.filial_destino)} · enviado em ${dataHoraBr(v.data_envio)}`;
  $("modal-ajuste-motivo").innerText = v.motivo_negacao ? `Pedida do admin: ${v.motivo_negacao}` : "";
  $("modal-ajuste-motivo").style.display = v.motivo_negacao ? "" : "none";
  evidenciasSelecionadas.ajuste = [];
  renderizarEvidenciasSelecionadas("lista-evidencias-ajuste", "ajuste");
  $("ajuste-obs").value = "";
  $("msg-modal-ajuste").classList.add("hidden");
  $("modal-resposta-admin").classList.remove("hidden");
}

function fecharModalAjuste() {
  $("modal-resposta-admin").classList.add("hidden");
  ajusteVendaId = null;
}

async function confirmarAjusteAvulso() {
  const v = vendasCache[ajusteVendaId];
  if (!v) return;
  const btn = $("btn-confirmar-ajuste");
  btn.disabled = true;
  btn.innerText = "Enviando...";
  try {
    const selecionadas = evidenciasSelecionadas.ajuste;
    const obs = $("ajuste-obs").value.trim();
    if (!selecionadas.length && !obs) {
      $("msg-modal-ajuste").innerText = "Adicione uma evidência ou escreva o que foi ajustado.";
      $("msg-modal-ajuste").classList.remove("hidden");
      return;
    }
    const evidencias = [];
    for (const sel of selecionadas) {
      const conteudo = await lerArquivoBruto(sel.arquivo);
      evidencias.push({ nome: sel.nome, conteudo });
    }
    const ajustes = [...(Array.isArray(v.ajustes) ? v.ajustes : []),
      { obs, evidencias, data: new Date().toISOString(), por: usuarioAtual.nome }];
    const { error } = await supabase.from("vendas_casadas")
      .update({ status: "pendente", ajustes })
      .eq("id", ajusteVendaId);
    if (error) throw error;

    fecharModalAjuste();
    await carregarVendasSupabase();
    renderizarVendas();
    renderizarInicio();
    atualizarModalDetalhe();
    mostrarToast("Ajuste enviado ao admin.");
  } catch (err) {
    $("msg-modal-ajuste").innerText = "Erro: " + err.message;
    $("msg-modal-ajuste").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.innerText = "Enviar ajuste";
  }
}

/* ---------- Expõe funções usadas nos onclick inline ---------- */
Object.assign(window, {
  toggleDropdown, toggleSidebarDesktop, toggleMobileMenu, mudarAba,
  atualizarTudo, sairDoSistema, abrirModalCadastro, fecharModalCadastro,
  abrirModalResposta, fecharModalResposta, confirmarResposta,
  baixarTransfPorId, baixarVendaPorId, baixarEvidenciaVenda, baixarEvidenciaAjuste,
  abrirModalAutorizacao, fecharModalAutorizacao,
  confirmarOkAutorizacao, confirmarRecusaAutorizacao,
  fecharModalDetalhe, abrirModalDetalheTransfLoja, abrirModalDetalheVendaLoja,
  abrirModalPedidoAvulso, fecharModalPedidoAvulso,
  abrirModalAjuste, fecharModalAjuste, confirmarAjusteAvulso,
  adicionarEvidencia, removerEvidencia,
  abrirModalAvisoRegra, fecharModalAvisoRegra
});