/* ============================================================
   Channels Funnels — JavaScript puro (Vanilla JS)
   ------------------------------------------------------------
   Estrutura:
   1. Estado + persistência (localStorage)
   2. Histórico (desfazer / refazer)
   3. Render: blocos e conexões
   4. Canvas: zoom + pan
   5. Interações: arrastar blocos, conectar, selecionar
   6. Modal de criação e painel lateral de edição
   ============================================================ */

(function () {
  "use strict";

  /* ------------------------------------------------------------
     1. Estado
     ------------------------------------------------------------ */
  const STORAGE_KEY = "channels-funnels:v1";
  const NODE_WIDTH = 210;

  /** @type {{name: string, nodes: any[], edges: any[]}} */
  let state = { name: "", nodes: [], edges: [] };

  // Viewport do canvas
  let view = { x: 120, y: 120, zoom: 1 };
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 2.5;

  let selectedNodeId = null;
  let editingNodeId = null;

  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.nodes)) {
        state = {
          name: typeof parsed.name === "string" ? parsed.name : "",
          nodes: parsed.nodes,
          edges: parsed.edges || [],
        };
        if (parsed.view) view = parsed.view;
      }
    } catch (err) {
      console.warn("Não foi possível carregar o quadro salvo.", err);
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, view }));
    } catch (err) {
      console.warn("Não foi possível salvar o quadro.", err);
    }
  }

  /* ------------------------------------------------------------
     2. Histórico (desfazer / refazer)
     ------------------------------------------------------------ */
  const history = { past: [], future: [] };
  const snapshot = () => JSON.stringify(state);

  /** Guarda o estado atual antes de uma alteração. */
  function commit() {
    history.past.push(snapshot());
    if (history.past.length > 100) history.past.shift();
    history.future.length = 0;
    save();
  }

  function undo() {
    if (!history.past.length) return;
    history.future.push(snapshot());
    state = JSON.parse(history.past.pop());
    afterHistory();
  }

  function redo() {
    if (!history.future.length) return;
    history.past.push(snapshot());
    state = JSON.parse(history.future.pop());
    afterHistory();
  }

  function afterHistory() {
    if (!state.nodes.some((n) => n.id === editingNodeId)) closePanel();
    save();
    render();
  }

  /* ------------------------------------------------------------
     Referências do DOM
     ------------------------------------------------------------ */
  const el = {
    canvas: document.getElementById("canvas"),
    world: document.getElementById("world"),
    edges: document.getElementById("edges"),
    nodes: document.getElementById("nodes"),
    emptyHint: document.getElementById("empty-hint"),
    modal: document.getElementById("modal"),
    createForm: document.getElementById("create-form"),
    createTitle: document.getElementById("create-title"),
    createName: document.getElementById("create-name"),
    panel: document.getElementById("panel"),
    panelName: document.getElementById("panel-name"),
    panelNotes: document.getElementById("panel-notes"),
    panelLinks: document.getElementById("panel-links"),
    zoomReset: document.getElementById("btn-zoom-reset"),
  };

  /* ------------------------------------------------------------
     3. Render
     ------------------------------------------------------------ */
  const nodeEls = new Map(); // id -> elemento

  function applyView() {
    el.world.style.transform =
      "translate(" + view.x + "px," + view.y + "px) scale(" + view.zoom + ")";
    el.zoomReset.textContent = Math.round(view.zoom * 100) + "%";
  }

  function render() {
    renderNodes();
    renderEdges();
    applyView();
    el.emptyHint.classList.toggle("hidden", state.nodes.length > 0);
  }

  function renderNodes() {
    el.nodes.textContent = "";
    nodeEls.clear();

    state.nodes.forEach((node) => {
      const box = document.createElement("div");
      box.className = "node" + (node.type === "decision" ? " decision" : "");
      if (node.id === selectedNodeId) box.classList.add("selected");
      box.style.left = node.x + "px";
      box.style.top = node.y + "px";
      box.dataset.id = node.id;

      const linksCount = (node.links || []).length;

      const kind = document.createElement("div");
      kind.className = "kind";
      kind.textContent = node.type === "decision" ? "Decisão" : "Etapa";

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = node.name;

      box.append(kind, title);

      if (linksCount || node.notes) {
        const meta = document.createElement("div");
        meta.className = "meta";
        if (linksCount) meta.append(tag("🔗 " + linksCount));
        if (node.notes) meta.append(tag("📝"));
        box.append(meta);
      }

      // Etapas iniciais (sem conexão de entrada) exibem apenas a saída.
      const hasIncoming = state.edges.some((edge) => edge.to === node.id);
      let inPort = null;
      if (hasIncoming) {
        inPort = document.createElement("div");
        inPort.className = "port in";
        inPort.title = "Entrada";
      }

      const outPort = document.createElement("div");
      outPort.className = "port out";
      outPort.title = "Arraste para conectar";
      outPort.dataset.port = "out";

      if (inPort) box.append(inPort);
      box.append(outPort);
      el.nodes.append(box);
      nodeEls.set(node.id, box);
    });
  }

  function tag(text) {
    const s = document.createElement("span");
    s.textContent = text;
    return s;
  }

  /** Mede a altura real do bloco (varia com conteúdo). */
  function nodeSize(node) {
    const box = nodeEls.get(node.id);
    return { w: NODE_WIDTH, h: box ? box.offsetHeight : 74 };
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const mk = (name, attrs) => {
    const node = document.createElementNS(svgNS, name);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  };

  /** Curva suave horizontal entre dois pontos. */
  function path(x1, y1, x2, y2) {
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function renderEdges() {
    el.edges.textContent = "";

    state.edges.forEach((edge) => {
      const from = state.nodes.find((n) => n.id === edge.from);
      const to = state.nodes.find((n) => n.id === edge.to);
      if (!from || !to) return;

      const a = nodeSize(from);
      const b = nodeSize(to);
      const x1 = from.x + a.w;
      const y1 = from.y + a.h / 2;
      const x2 = to.x;
      const y2 = to.y + b.h / 2;
      const d = path(x1, y1, x2, y2);

      const g = mk("g", { class: "edge-group" });
      g.append(mk("path", { class: "edge-line", d }));
      const hit = mk("path", { class: "edge-hit", d });
      hit.addEventListener("click", () => editEdge(edge.id));
      g.append(hit);

      // rótulo da conexão
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      if (edge.label) {
        const w = Math.max(26, edge.label.length * 7 + 14);
        g.append(
          mk("rect", {
            class: "edge-label-bg",
            x: mx - w / 2,
            y: my - 11,
            width: w,
            height: 20,
            rx: 6,
          }),
        );
        const text = mk("text", { class: "edge-label", x: mx, y: my + 3 });
        text.textContent = edge.label;
        g.append(text);
      }

      el.edges.append(g);
    });
  }

  /** Edita ou remove o rótulo de uma conexão. */
  function editEdge(edgeId) {
    const edge = state.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const value = window.prompt(
      'Rótulo da conexão (ex.: SIM, NÃO, VIP). Deixe vazio para remover o texto. Digite "excluir" para apagar a conexão.',
      edge.label || "",
    );
    if (value === null) return;
    commit();
    if (value.trim().toLowerCase() === "excluir") {
      state.edges = state.edges.filter((e) => e.id !== edgeId);
    } else {
      edge.label = value.trim();
    }
    save();
    render();
  }

  /* ------------------------------------------------------------
     4. Canvas: zoom + pan
     ------------------------------------------------------------ */
  // Zoom proporcional ao delta, ancorado no cursor.
  el.canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const next = clamp(view.zoom * Math.exp(-dy * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const rect = el.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const k = next / view.zoom;
      view.x = px - (px - view.x) * k;
      view.y = py - (py - view.y) * k;
      view.zoom = next;
      applyView();
      save();
    },
    { passive: false },
  );

  function zoomBy(factor) {
    const rect = el.canvas.getBoundingClientRect();
    const px = rect.width / 2;
    const py = rect.height / 2;
    const next = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const k = next / view.zoom;
    view.x = px - (px - view.x) * k;
    view.y = py - (py - view.y) * k;
    view.zoom = next;
    applyView();
    save();
  }

  /* ------------------------------------------------------------
     5. Interações com ponteiro
     ------------------------------------------------------------ */
  let drag = null; // { mode: 'pan' | 'node' | 'link', ... }

  /** Converte coordenadas de tela para coordenadas do mundo. */
  function toWorld(clientX, clientY) {
    const rect = el.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.zoom,
      y: (clientY - rect.top - view.y) / view.zoom,
    };
  }

  el.canvas.addEventListener("pointerdown", (e) => {
    const port = e.target.closest(".port.out");
    const box = e.target.closest(".node");

    if (port && box) {
      // início de uma conexão
      const node = state.nodes.find((n) => n.id === box.dataset.id);
      drag = { mode: "link", fromId: node.id, temp: mk("path", { class: "temp-line" }) };
      el.edges.append(drag.temp);
      el.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (box) {
      const node = state.nodes.find((n) => n.id === box.dataset.id);
      selectNode(node.id);
      const p = toWorld(e.clientX, e.clientY);
      drag = {
        mode: "node",
        id: node.id,
        offX: p.x - node.x,
        offY: p.y - node.y,
        moved: false,
      };
      box.classList.add("dragging");
      el.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.target.closest(".edge-hit")) return;

    // pan do canvas
    selectNode(null);
    drag = { mode: "pan", startX: e.clientX - view.x, startY: e.clientY - view.y };
    el.canvas.classList.add("panning");
    el.canvas.setPointerCapture(e.pointerId);
  });

  el.canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;

    if (drag.mode === "pan") {
      view.x = e.clientX - drag.startX;
      view.y = e.clientY - drag.startY;
      applyView();
      return;
    }

    if (drag.mode === "node") {
      const node = state.nodes.find((n) => n.id === drag.id);
      if (!node) return;
      if (!drag.moved) {
        commit(); // salva posição anterior no histórico apenas uma vez
        drag.moved = true;
      }
      const p = toWorld(e.clientX, e.clientY);
      node.x = Math.round(p.x - drag.offX);
      node.y = Math.round(p.y - drag.offY);
      const box = nodeEls.get(node.id);
      box.style.left = node.x + "px";
      box.style.top = node.y + "px";
      renderEdges();
      return;
    }

    if (drag.mode === "link") {
      const from = state.nodes.find((n) => n.id === drag.fromId);
      const a = nodeSize(from);
      const p = toWorld(e.clientX, e.clientY);
      drag.temp.setAttribute("d", path(from.x + a.w, from.y + a.h / 2, p.x, p.y));
    }
  });

  el.canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;

    if (drag.mode === "link") {
      drag.temp.remove();
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const box = target && target.closest(".node");
      if (box && box.dataset.id !== drag.fromId) {
        connect(drag.fromId, box.dataset.id);
      }
    }

    if (drag.mode === "node") {
      const box = nodeEls.get(drag.id);
      if (box) box.classList.remove("dragging");
      if (drag.moved) save();
    }

    if (drag.mode === "pan") {
      el.canvas.classList.remove("panning");
      save();
    }

    drag = null;
  });

  // duplo clique abre o painel de edição
  el.canvas.addEventListener("dblclick", (e) => {
    // Usa hit-test por coordenada: durante o arraste o pointer capture
    // pode reatribuir o target do clique para o canvas.
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const box = target && target.closest(".node");
    if (box) openPanel(box.dataset.id);
  });

  /* ------------------------------------------------------------
     Operações de domínio
     ------------------------------------------------------------ */
  function selectNode(id) {
    if (selectedNodeId === id) return;
    selectedNodeId = id;
    nodeEls.forEach((box, nodeId) => box.classList.toggle("selected", nodeId === id));
  }

  function createNode(name, type) {
    const rect = el.canvas.getBoundingClientRect();
    // posiciona no centro visível, deslocando para a direita conforme o fluxo cresce
    const center = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    // Fluxo horizontal: o novo bloco nasce à direita do bloco mais à direita.
    let x = Math.round(center.x - NODE_WIDTH / 2);
    let y = Math.round(center.y - 40);
    if (state.nodes.length) {
      const last = state.nodes.reduce((a, b) => (b.x > a.x ? b : a));
      x = last.x + NODE_WIDTH + 110;
      y = last.y;
    }
    const node = { id: uid(), type, name, notes: "", links: [], x, y };
    commit();
    state.nodes.push(node);
    save();
    render();
    selectNode(node.id);
    return node;
  }

  function duplicateNode(id) {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    commit();
    const copy = JSON.parse(JSON.stringify(node));
    copy.id = uid();
    copy.name = node.name + " (copia)";
    copy.x = node.x + 40;
    copy.y = node.y + 60;
    state.nodes.push(copy);
    save();
    render();
    selectNode(copy.id);
  }

  function deleteNode(id) {
    commit();
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
    if (editingNodeId === id) closePanel();
    save();
    render();
  }

  function connect(fromId, toId) {
    const exists = state.edges.some((e) => e.from === fromId && e.to === toId);
    if (exists) return;
    commit();
    state.edges.push({ id: uid(), from: fromId, to: toId, label: "" });
    save();
    render();
  }

  /* ------------------------------------------------------------
     6. Modal de criação
     ------------------------------------------------------------ */
  let createType = "step";

  function openModal(type) {
    createType = type;
    el.createTitle.textContent = type === "decision" ? "Nova Decisão" : "Nova Etapa";
    el.createName.placeholder =
      type === "decision" ? "Ex.: Comprou?" : "Ex.: Página de Captação";
    el.createName.value = "";
    el.modal.classList.remove("hidden");
    el.createName.focus();
  }

  function closeModal() {
    el.modal.classList.add("hidden");
  }

  el.createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = el.createName.value.trim();
    if (!name) return;
    createNode(name, createType);
    closeModal();
  });

  el.modal.addEventListener("click", (e) => {
    if (e.target === el.modal || e.target.hasAttribute("data-close-modal")) closeModal();
  });

  /* ------------------------------------------------------------
     Painel lateral de edição
     ------------------------------------------------------------ */
  function currentNode() {
    return state.nodes.find((n) => n.id === editingNodeId);
  }

  function openPanel(id) {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    editingNodeId = id;
    selectNode(id);
    el.panelName.value = node.name;
    el.panelNotes.value = node.notes || "";
    renderPanelLinks();
    el.panel.classList.remove("hidden");
  }

  function closePanel() {
    editingNodeId = null;
    el.panel.classList.add("hidden");
  }

  document.getElementById("panel-close").addEventListener("click", closePanel);

  el.panelName.addEventListener("change", () => {
    const node = currentNode();
    if (!node) return;
    commit();
    node.name = el.panelName.value.trim() || node.name;
    save();
    render();
  });

  el.panelNotes.addEventListener("change", () => {
    const node = currentNode();
    if (!node) return;
    commit();
    node.notes = el.panelNotes.value;
    save();
    render();
  });

  document.getElementById("panel-add-link").addEventListener("click", () => {
    const node = currentNode();
    if (!node) return;
    commit();
    node.links = node.links || [];
    node.links.push({ id: uid(), name: "", url: "", note: "" });
    save();
    renderPanelLinks();
    render();
  });

  /** Renderiza a lista de links (ilimitados) da etapa em edição. */
  function renderPanelLinks() {
    const node = currentNode();
    el.panelLinks.textContent = "";
    if (!node) return;
    const links = node.links || [];

    if (!links.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Nenhum link cadastrado.";
      el.panelLinks.append(p);
      return;
    }

    links.forEach((link, index) => {
      const card = document.createElement("div");
      card.className = "link-card";

      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = "Link " + (index + 1);
      const tools = document.createElement("div");
      tools.className = "tools";
      tools.append(
        toolBtn("↑", "Mover para cima", () => moveLink(index, -1)),
        toolBtn("↓", "Mover para baixo", () => moveLink(index, 1)),
        toolBtn("✕", "Remover link", () => removeLink(link.id)),
      );
      row.append(label, tools);

      card.append(
        row,
        field("Nome", link.name, "Ex.: Landing Principal", (v) => updateLink(link.id, "name", v)),
        field("URL", link.url, "https://...", (v) => updateLink(link.id, "url", v)),
        field("Observação", link.note, "Ex.: Página usada no Meta Ads", (v) =>
          updateLink(link.id, "note", v),
        ),
      );

      if (link.url) {
        const open = document.createElement("a");
        open.href = link.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.textContent = "Abrir link ↗";
        open.style.cssText = "font-size:12px;color:var(--accent);text-decoration:none";
        card.append(open);
      }

      el.panelLinks.append(card);
    });
  }

  function toolBtn(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "btn btn-small";
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function field(labelText, value, placeholder, onChange) {
    const wrap = document.createElement("label");
    wrap.append(document.createTextNode(labelText));
    const input = document.createElement("input");
    input.value = value || "";
    input.placeholder = placeholder;
    input.addEventListener("change", () => onChange(input.value));
    wrap.append(input);
    return wrap;
  }

  function updateLink(linkId, key, value) {
    const node = currentNode();
    if (!node) return;
    const link = node.links.find((l) => l.id === linkId);
    if (!link) return;
    commit();
    link[key] = value;
    save();
    renderPanelLinks();
    render();
  }

  function removeLink(linkId) {
    const node = currentNode();
    if (!node) return;
    commit();
    node.links = node.links.filter((l) => l.id !== linkId);
    save();
    renderPanelLinks();
    render();
  }

  function moveLink(index, dir) {
    const node = currentNode();
    if (!node) return;
    const target = index + dir;
    if (target < 0 || target >= node.links.length) return;
    commit();
    const [item] = node.links.splice(index, 1);
    node.links.splice(target, 0, item);
    save();
    renderPanelLinks();
  }

  document.getElementById("panel-duplicate").addEventListener("click", () => {
    if (editingNodeId) duplicateNode(editingNodeId);
  });

  document.getElementById("panel-delete").addEventListener("click", () => {
    if (!editingNodeId) return;
    if (window.confirm("Excluir esta etapa e suas conexões?")) deleteNode(editingNodeId);
  });

  /* ------------------------------------------------------------
     Exportar / Importar (formato .json nativo da ferramenta)
     ------------------------------------------------------------ */
  const FILE_FORMAT = "channels-funnels";
  const FILE_VERSION = 1;

  function exportBoard() {
    const payload = {
      format: FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: new Date().toISOString(),
      name: state.name,
      view: view,
      nodes: state.nodes,
      edges: state.edges,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = (state.name || "channels-funnels")
      .trim()
      .replace(/[\\/?%*:|"<>]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    a.href = url;
    a.download = (slug || "channels-funnels") + "-" + stamp + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importBoard(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || !Array.isArray(data.nodes)) throw new Error("Arquivo inválido");
        if (data.format && data.format !== FILE_FORMAT) throw new Error("Formato incompatível");

        // Normaliza os dados para o formato interno atual.
        const nodes = data.nodes.map((n) => ({
          id: n.id || uid(),
          type: n.type === "decision" ? "decision" : "step",
          name: n.name || "Etapa",
          notes: n.notes || "",
          links: Array.isArray(n.links)
            ? n.links.map((l) => ({
                id: l.id || uid(),
                name: l.name || "",
                url: l.url || "",
                note: l.note || "",
              }))
            : [],
          x: Number(n.x) || 0,
          y: Number(n.y) || 0,
        }));
        const ids = new Set(nodes.map((n) => n.id));
        const edges = (Array.isArray(data.edges) ? data.edges : [])
          .filter((e) => ids.has(e.from) && ids.has(e.to))
          .map((e) => ({ id: e.id || uid(), from: e.from, to: e.to, label: e.label || "" }));

        commit();
        state = {
          name: typeof data.name === "string" ? data.name : "",
          nodes: nodes,
          edges: edges,
        };
        if (data.view && typeof data.view.zoom === "number") {
          view = {
            x: Number(data.view.x) || 0,
            y: Number(data.view.y) || 0,
            zoom: clamp(data.view.zoom, MIN_ZOOM, MAX_ZOOM),
          };
        }
        const nameInput = document.getElementById("funnel-name");
        if (nameInput) nameInput.value = state.name;
        closePanel();
        save();
        render();
      } catch (err) {
        window.alert("Não foi possível importar: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  document.getElementById("btn-export").addEventListener("click", exportBoard);
  document.getElementById("btn-import").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) importBoard(file);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });

  /* ------------------------------------------------------------
     Barra de ferramentas + atalhos
     ------------------------------------------------------------ */
  document.getElementById("btn-new-step").addEventListener("click", () => openModal("step"));
  document
    .getElementById("btn-new-decision")
    .addEventListener("click", () => openModal("decision"));
  document.getElementById("btn-undo").addEventListener("click", undo);
  document.getElementById("btn-redo").addEventListener("click", redo);
  document.getElementById("btn-zoom-in").addEventListener("click", () => zoomBy(1.2));
  document.getElementById("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
  el.zoomReset.addEventListener("click", () => {
    view = { x: 120, y: 120, zoom: 1 };
    applyView();
    save();
  });
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (!state.nodes.length) return;
    if (!window.confirm("Limpar todo o quadro?")) return;
    commit();
    state = { nodes: [], edges: [] };
    closePanel();
    save();
    render();
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);

    if (e.key === "Escape") {
      closeModal();
      closePanel();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (typing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
      e.preventDefault();
      deleteNode(selectedNodeId);
    }
    if (e.key.toLowerCase() === "n") openModal("step");
    if (e.key.toLowerCase() === "d" && selectedNodeId) duplicateNode(selectedNodeId);
  });

  window.addEventListener("resize", renderEdges);

  const nameInput = document.getElementById("funnel-name");
  if (nameInput) {
    nameInput.value = state.name;
    nameInput.addEventListener("input", () => {
      state.name = nameInput.value;
      save();
    });
  }

  /* ------------------------------------------------------------
     Inicialização
     ------------------------------------------------------------ */
  load();
  if (nameInput) nameInput.value = state.name;
  render();
})();
