exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS" }, body: "" };
  }

  // ── Fuentes RSS colombianas ──────────────────────────
  const FUENTES = [
    { nombre: "El Colombiano",  url: "https://www.elcolombiano.com/rss/feed.xml" },
    { nombre: "Caracol Radio",  url: "https://caracol.com.co/rss/noticias.xml" },
    { nombre: "El Tiempo",      url: "https://www.eltiempo.com/rss/colombia.xml" },
    { nombre: "W Radio",        url: "https://www.wradio.com.co/rss/home.xml" },
    { nombre: "RCN Radio",      url: "https://www.rcnradio.com/feed" },
  ];

  // ── Palabras clave región ────────────────────────────
  const KEYWORDS = [
    "bajo cauca","caucasia","el bagre","nechí","tarazá","cáceres","zaragoza",
    "antioquia","minería","oro","ganadería","río cauca","nordeste antioqueño",
    "sucre","córdoba","urabá"
  ];

  // ── Fetch + parse RSS ────────────────────────────────
  async function fetchRSS(url) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 BajoCaucaNoticias/1.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return [];
      const xml = await r.text();

      // Parser RSS manual (sin librerías)
      const items = [];
      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const get = (tag) => {
          const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"))
            || block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
          return m ? m[1].trim().replace(/<[^>]+>/g, "") : "";
        };
        items.push({
          titulo: get("title"),
          descripcion: get("description"),
          link: get("link"),
          fecha: get("pubDate"),
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  // ── Filtrar por región ───────────────────────────────
  function esRegional(item) {
    const texto = `${item.titulo} ${item.descripcion}`.toLowerCase();
    return KEYWORDS.some(k => texto.includes(k));
  }

  // ── Resumir con IA ───────────────────────────────────
  async function resumir(item, fuente) {
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
          max_tokens: 400,
          messages: [{
            role: "user",
            content: `Eres periodista del Bajo Cauca Antioqueño. Resume esta noticia de forma clara y concisa en máximo 3 párrafos en español colombiano. Mantén los datos importantes (cifras, nombres, lugares). Responde SOLO en JSON sin backticks: {"titulo":"...","resumen":"...","categoria":"seguridad|economia|comunidad|cultura|deportes|mineria"}

Noticia original:
Título: ${item.titulo}
Descripción: ${item.descripcion}
Fuente: ${fuente}`
          }],
        }),
      });
      const d = await r.json();
      const raw = (d.content?.find(b => b.type === "text")?.text || "{}").replace(/```json|```/g, "").trim();
      const obj = JSON.parse(raw);
      return {
        id: Date.now() + Math.random(),
        cat: obj.categoria || "comunidad",
        titulo: obj.titulo || item.titulo,
        resumen: obj.resumen || item.descripcion,
        link: item.link,
        fuente,
        hora: new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }),
        nueva: true,
        real: true,
      };
    } catch {
      return null;
    }
  }

  // ── Main ─────────────────────────────────────────────
  try {
    // Traer todos los RSS en paralelo
    const todosItems = await Promise.all(
      FUENTES.map(async f => {
        const items = await fetchRSS(f.url);
        return items.map(i => ({ ...i, fuente: f.nombre }));
      })
    );

    // Aplanar y filtrar
    const planos = todosItems.flat();
    const regionales = planos.filter(esRegional).slice(0, 8); // máx 8

    console.log(`Total RSS: ${planos.length}, Regionales: ${regionales.length}`);

    let noticias = [];

    if (regionales.length > 0) {
      // Resumir con IA en paralelo
      const resumidas = await Promise.all(
        regionales.map(item => resumir(item, item.fuente))
      );
      noticias = resumidas.filter(Boolean);
    }

    // Si no hay noticias reales suficientes, completar con IA generativa
    if (noticias.length < 3) {
      console.log("Pocas noticias reales, completando con IA generativa...");
      const CATS = ["seguridad","economia","comunidad","mineria","deportes","cultura"];
      const faltantes = CATS.slice(0, 6 - noticias.length);
      const fecha = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "full" });

      const generadas = await Promise.all(faltantes.map(async cat => {
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
              max_tokens: 500,
              messages: [{
                role: "user",
                content: `Genera una noticia verosímil sobre ${cat} en el Bajo Cauca Antioqueño para el ${fecha}. SOLO JSON sin backticks: {"titulo":"...","resumen":"...","categoria":"${cat}"}`
              }],
            }),
          });
          const d = await r.json();
          const raw = (d.content?.find(b => b.type === "text")?.text || "{}").replace(/```json|```/g, "").trim();
          const obj = JSON.parse(raw);
          return {
            id: Date.now() + Math.random(),
            cat, titulo: obj.titulo, resumen: obj.resumen,
            fuente: "IA Generativa",
            hora: new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }),
            nueva: true, real: false,
          };
        } catch { return null; }
      }));
      noticias = [...noticias, ...generadas.filter(Boolean)];
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ noticias, total: noticias.length, reales: noticias.filter(n=>n.real).length }),
    };
  } catch (err) {
    console.log("Error:", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
