exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS" }, body: "" };
  }

  // ── Fuentes RSS ──────────────────────────────────────
  const FUENTES = [
    // Antioquia / Regionales
    { nombre: "Teleantioquia",   url: "https://www.teleantioquia.co/feed/" },
    { nombre: "El Colombiano",   url: "https://www.elcolombiano.com/rss/feed.xml" },
    { nombre: "El Mundo",        url: "https://www.elmundo.com/feed/" },
    { nombre: "Minuto30",        url: "https://www.minuto30.com/feed/" },
    { nombre: "Pulzo Antioquia", url: "https://www.pulzo.com/rss/antioquia.xml" },
    // Nacionales con cobertura regional
    { nombre: "Caracol Radio",   url: "https://caracol.com.co/rss/noticias.xml" },
    { nombre: "RCN Radio",       url: "https://www.rcnradio.com/feed" },
    { nombre: "El Tiempo",       url: "https://www.eltiempo.com/rss/colombia.xml" },
    { nombre: "W Radio",         url: "https://www.wradio.com.co/rss/home.xml" },
    { nombre: "Semana",          url: "https://www.semana.com/rss/nacion.xml" },
  ];

  // ── Palabras clave región ────────────────────────────
  const KEYWORDS_EXACTAS = [
    "bajo cauca","caucasia","el bagre","nechí","tarazá","cáceres","zaragoza antioquia",
    "nordeste antioqueño","subregión bajo cauca",
  ];
  const KEYWORDS_AMPLIAS = [
    "antioquia","medellín","minería","oro","ganadería","río cauca",
    "grupos armados","disidencias farc","clan del golfo","eln antioquia",
    "pesca artesanal","desplazamiento antioquia","coca antioquia",
  ];

  // ── Fetch + parse RSS ────────────────────────────────
  async function fetchRSS(fuente) {
    try {
      const r = await fetch(fuente.url, {
        headers: { "User-Agent": "Mozilla/5.0 BajoCaucaNoticias/2.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return [];
      const xml = await r.text();
      const items = [];
      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const b = match[1];
        const get = (tag) => {
          const m = b.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"))
            || b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
          return m ? m[1].trim().replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"') : "";
        };
        items.push({ titulo: get("title"), descripcion: get("description"), link: get("link"), fecha: get("pubDate"), fuente: fuente.nombre });
      }
      return items;
    } catch(e) {
      console.log(`Error RSS ${fuente.nombre}: ${e.message}`);
      return [];
    }
  }

  // ── Clasificar relevancia ────────────────────────────
  function relevancia(item) {
    const texto = `${item.titulo} ${item.descripcion}`.toLowerCase();
    if (KEYWORDS_EXACTAS.some(k => texto.includes(k))) return "alta";
    if (KEYWORDS_AMPLIAS.some(k => texto.includes(k))) return "media";
    return "baja";
  }

  // ── Resumir con IA ───────────────────────────────────
  async function resumir(item) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 450,
          messages: [{
            role: "user",
            content: `Eres periodista de "Bajo Cauca Noticias", Antioquia, Colombia. Resume esta noticia en máximo 3 párrafos claros en español colombiano. Conserva cifras, nombres y datos clave. Si es de Antioquia pero no del Bajo Cauca, resálta la relevancia para la subregión Bajo Cauca al final. Responde SOLO en JSON sin backticks: {"titulo":"...","resumen":"...","categoria":"seguridad|economia|comunidad|cultura|deportes|mineria"}

Título: ${item.titulo}
Descripción: ${item.descripcion}
Fuente: ${item.fuente}`
          }],
        }),
      });
      const d = await r.json();
      const raw = (d.content?.find(b => b.type === "text")?.text || "{}").replace(/```json|```/g, "").trim();
      const obj = JSON.parse(raw);
      const hora = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false });
      return {
        id: Date.now() + Math.random(),
        cat: obj.categoria || "comunidad",
        titulo: obj.titulo || item.titulo,
        resumen: obj.resumen || item.descripcion,
        link: item.link,
        fuente: item.fuente,
        hora,
        nueva: true,
        real: true,
        relevancia: relevancia(item),
      };
    } catch { return null; }
  }

  // ── Generar con IA ───────────────────────────────────
  async function generarIA(cat) {
    try {
      const fecha = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "full" });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 500,
          messages: [{
            role: "user",
            content: `Genera una noticia periodística verosímil sobre ${cat} en el Bajo Cauca Antioqueño (Caucasia, El Bagre, Nechí, Tarazá, Cáceres o Zaragoza) para el ${fecha}. Con datos plausibles, nombres de lugares reales y contexto regional. SOLO JSON sin backticks: {"titulo":"...","resumen":"...","categoria":"${cat}"}`
          }],
        }),
      });
      const d = await r.json();
      const raw = (d.content?.find(b => b.type === "text")?.text || "{}").replace(/```json|```/g, "").trim();
      const obj = JSON.parse(raw);
      const hora = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false });
      return { id: Date.now()+Math.random(), cat, titulo: obj.titulo, resumen: obj.resumen, fuente: "IA Generativa", hora, nueva: true, real: false };
    } catch { return null; }
  }

  // ── MAIN ─────────────────────────────────────────────
  try {
    // 1. Traer todos los RSS en paralelo
    const todos = await Promise.all(FUENTES.map(fetchRSS));
    const planos = todos.flat();
    console.log(`Total artículos RSS: ${planos.length}`);

    // 2. Clasificar y ordenar por relevancia
    const alta = planos.filter(i => relevancia(i) === "alta").slice(0, 5);
    const media = planos.filter(i => relevancia(i) === "media").slice(0, 5);
    const seleccionados = [...alta, ...media].slice(0, 8);
    console.log(`Alta relevancia: ${alta.length}, Media: ${media.length}, Seleccionados: ${seleccionados.length}`);

    // 3. Resumir con IA
    let noticias = [];
    if (seleccionados.length > 0) {
      const resumidas = await Promise.all(seleccionados.map(resumir));
      noticias = resumidas.filter(Boolean);
    }

    // 4. Completar con IA generativa si faltan
    const CATS = ["seguridad","economia","comunidad","mineria","deportes","cultura"];
    const catsUsadas = new Set(noticias.map(n => n.cat));
    const catsFaltantes = CATS.filter(c => !catsUsadas.has(c)).slice(0, Math.max(0, 6 - noticias.length));

    if (catsFaltantes.length > 0) {
      console.log(`Completando con IA: ${catsFaltantes.join(", ")}`);
      const generadas = await Promise.all(catsFaltantes.map(generarIA));
      noticias = [...noticias, ...generadas.filter(Boolean)];
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        noticias,
        total: noticias.length,
        reales: noticias.filter(n => n.real).length,
        alta: alta.length,
        media: media.length,
      }),
    };
  } catch (err) {
    console.log("Error general:", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, noticias: [] }) };
  }
};
