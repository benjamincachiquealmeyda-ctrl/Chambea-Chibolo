const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'solicitudes.json');
const CHAT_FILE = path.join(__dirname, 'chat.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const LOGO_FILE = path.join(__dirname, 'Logo Estilista Minimalista Dorado y Beige.png');
const eventClients = new Set();

function ensureFile(filePath, defaultContent = '[]') {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
}

function ensureDataFiles() {
  ensureFile(DATA_FILE);
  ensureFile(CHAT_FILE);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readHtml(req, res) {
  fs.readFile(HTML_FILE, 'utf8', (err, html) => {
    if (err) {
      sendJson(res, 500, { message: 'No se pudo cargar la página.' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
  } catch (error) {
    return [];
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function broadcastUpdate(type, payload) {
  const message = `data: ${JSON.stringify({ type, payload })}\n\n`;
  for (const client of eventClients) {
    client.write(message);
  }
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(new Error('El cuerpo de la petición no es un JSON válido.'));
      }
    });

    req.on('error', (error) => reject(error));
  });
}

const server = http.createServer(async (req, res) => {
  ensureDataFiles();

  if (req.method === 'GET' && req.url === '/') {
    readHtml(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/logo.png') {
    fs.readFile(LOGO_FILE, (err, image) => {
      if (err) {
        sendJson(res, 404, { message: 'No se pudo cargar el logo.' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache'
      });
      res.end(image);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 1000\n\n');
    eventClients.add(res);

    req.on('close', () => {
      eventClients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/solicitudes') {
    try {
      const solicitudes = readJson(DATA_FILE);
      sendJson(res, 200, solicitudes);
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudieron leer las solicitudes.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/solicitudes') {
    try {
      const data = await parseRequestBody(req);
      const isEmpresa = data.tipo === 'empresa';
      const isTrabajador = data.tipo === 'trabajador';

      if (!isEmpresa && !isTrabajador) {
        sendJson(res, 400, { message: 'Tipo de solicitud no válido.' });
        return;
      }

      if (isTrabajador) {
        sendJson(res, 400, { message: 'Los trabajadores deben crear un perfil; no se publican solicitudes de trabajo.' });
        return;
      }

      if (isEmpresa && (!data.nombre || !data.cuentaGoogle || !data.ciudad || !data.mensaje)) {
        sendJson(res, 400, { message: 'Faltan campos obligatorios de empresa.' });
        return;
      }

      if (isTrabajador && (!data.nombre || !data.cuentaGoogle || !data.distrito || !data.mensaje)) {
        sendJson(res, 400, { message: 'Faltan campos obligatorios de trabajador.' });
        return;
      }

      const solicitudes = readJson(DATA_FILE);
      const record = {
        ...data,
        createdBy: String(data.createdBy || data.nombre || '').trim(),
        id: data.id || `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      };

      solicitudes.push(record);
      writeJson(DATA_FILE, solicitudes);
      broadcastUpdate('catalog', { requests: solicitudes });

      sendJson(res, 200, { ok: true, message: 'Solicitud guardada correctamente.', data: record });
    } catch (error) {
      sendJson(res, 500, { message: 'Error al guardar la solicitud.', error: error.message });
    }
    return;
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/solicitudes/')) {
    try {
      const id = decodeURIComponent(req.url.replace('/api/solicitudes/', ''));
      const requester = String(req.headers['x-user-name'] || '').trim();
      const solicitudes = readJson(DATA_FILE);
      const index = solicitudes.findIndex((item) => String(item.id || item.fecha || '').toLowerCase() === String(id).toLowerCase());

      if (index === -1) {
        sendJson(res, 404, { message: 'Solicitud no encontrada.' });
        return;
      }

      const target = solicitudes[index];
      const owner = String(target.createdBy || target.nombre || '').trim();
      if (!requester || !owner || requester !== owner) {
        sendJson(res, 403, { message: 'Solo el creador de la publicación puede eliminarla.' });
        return;
      }

      const [deleted] = solicitudes.splice(index, 1);
      writeJson(DATA_FILE, solicitudes);
      const mensajes = readJson(CHAT_FILE);
      const deletedRequestId = String(deleted.id || '');
      const deletedOwner = String(deleted.createdBy || deleted.nombre || '').trim().toLowerCase();
      const mensajesRestantes = mensajes.filter((message) => {
        if (String(message.requestId || '') === deletedRequestId) {
          return false;
        }

        if (!message.requestId && deletedOwner) {
          const from = String(message.from || message.nombre || '').trim().toLowerCase();
          const to = String(message.to || message.destinatario || '').trim().toLowerCase();
          if (from === deletedOwner || to === deletedOwner) {
            return false;
          }
        }

        return true;
      });
      if (mensajesRestantes.length !== mensajes.length) {
        writeJson(CHAT_FILE, mensajesRestantes);
        broadcastUpdate('chat', { messages: mensajesRestantes });
      }
      broadcastUpdate('catalog', { requests: solicitudes });
      sendJson(res, 200, { ok: true, message: 'Solicitud eliminada.', data: deleted });
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudo eliminar la solicitud.', error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/chat') {
    try {
      const mensajes = readJson(CHAT_FILE);
      sendJson(res, 200, mensajes);
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudieron leer los mensajes.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const data = await parseRequestBody(req);
      const from = String(data.from || '').trim();
      const to = String(data.to || '').trim();
      const text = String(data.text || data.mensaje || '').trim();

      if (!from || !to || !text) {
        sendJson(res, 400, { message: 'Faltan datos para enviar el mensaje.' });
        return;
      }

      const mensajes = readJson(CHAT_FILE);
      const record = {
        id: data.id || `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        from,
        to,
        text,
        nombre: from,
        texto: text,
        requestId: data.requestId || null,
        fecha: data.fecha || new Date().toISOString()
      };

      mensajes.push(record);
      writeJson(CHAT_FILE, mensajes);
      broadcastUpdate('chat', { messages: mensajes });
      sendJson(res, 200, { ok: true, message: 'Mensaje enviado.', data: record });
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudo guardar el mensaje.', error: error.message });
    }
    return;
  }

  sendJson(res, 404, { message: 'Ruta no encontrada.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`También disponible en http://0.0.0.0:${PORT}`);
});