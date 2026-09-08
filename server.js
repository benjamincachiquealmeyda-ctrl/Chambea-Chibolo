const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'solicitudes.json');
const CHAT_FILE = path.join(__dirname, 'chat.json');
const USERS_FILE = path.join(__dirname, 'usuarios.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const CONTACT_HTML_FILE = path.join(__dirname, 'contact.html');
const LOGO_FILE = path.join(__dirname, 'Logo Estilista Minimalista Dorado y Beige.png');
const eventClients = new Map();

function ensureFile(filePath, defaultContent = '[]') {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
}

function ensureDataFiles() {
  ensureFile(DATA_FILE);
  ensureFile(CHAT_FILE);
  ensureFile(USERS_FILE);
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

function readContactHtml(req, res) {
  fs.readFile(CONTACT_HTML_FILE, 'utf8', (err, html) => {
    if (err) {
      sendJson(res, 500, { message: 'No se pudo cargar la página de contacto.' });
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

function toPublicRequest(request) {
  const publicRequest = { ...request };
  delete publicRequest.cuentaGoogle;
  delete publicRequest.email;
  delete publicRequest.correo;
  delete publicRequest.ruc;
  delete publicRequest.verificacionRuc;
  return publicRequest;
}

function getSmtpConfig() {
  const port = Number(process.env.SMTP_PORT || 465);
  const password = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const secureValue = String(process.env.SMTP_SECURE || '').trim().toLowerCase();

  return {
    host: String(process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    port,
    secure: secureValue ? secureValue === 'true' : port === 465,
    user: String(process.env.SMTP_USER || '').trim(),
    password
  };
}

function getMailErrorMessage(error) {
  if (error?.code === 'EAUTH' || error?.responseCode === 535) {
    return 'Gmail rechazó la autenticación. Revisa SMTP_USER y usa una contraseña de aplicación válida en SMTP_PASS.';
  }
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNECTION' || error?.code === 'ESOCKET') {
    return 'No se pudo conectar con Gmail. Revisa SMTP_HOST, SMTP_PORT y SMTP_SECURE.';
  }
  return 'No se pudo enviar el reporte. Revisa los logs de Render para ver el código del error.';
}

async function sendSupportEmail({ name, email, type, message, supportEmail }) {
  const emailText = `Nombre: ${name}\nCorreo de respuesta: ${email}\nMotivo: ${type}\n\n${message}`;
  const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();

  if (resendApiKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Chambea Chibolo <onboarding@resend.dev>',
        to: [supportEmail],
        reply_to: email,
        subject: `${type} - Chambea Chibolo`,
        text: emailText
      })
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      const error = new Error(result.message || 'Resend rechazó el correo.');
      error.code = 'RESEND_ERROR';
      throw error;
    }
    return;
  }

  const smtp = getSmtpConfig();
  if (!smtp.user || !smtp.password) {
    const error = new Error('Falta configurar RESEND_API_KEY o las variables SMTP.');
    error.code = 'MAIL_CONFIG';
    throw error;
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: smtp.user, pass: smtp.password }
  });

  await transporter.verify();
  await transporter.sendMail({
    from: smtp.user,
    to: supportEmail,
    replyTo: email,
    subject: `${type} - Chambea Chibolo`,
    text: emailText
  });
}

function normalizeUser(value) {
  return String(value || '').trim().toLowerCase();
}

function messageBelongsToUser(message, userName) {
  const currentUser = normalizeUser(userName);
  if (!currentUser) return false;

  const from = normalizeUser(message.from || message.nombre);
  const to = normalizeUser(message.to || message.destinatario);
  return from === currentUser || to === currentUser;
}

function broadcastUpdate(type, payload) {
  for (const [client, userName] of eventClients) {
    const visiblePayload = type === 'chat'
      ? { messages: (Array.isArray(payload.messages) ? payload.messages : []).filter((message) => messageBelongsToUser(message, userName)) }
      : payload;
    client.write(`data: ${JSON.stringify({ type, payload: visiblePayload })}\n\n`);
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

  if (req.method === 'GET' && req.url === '/contacto') {
    readContactHtml(req, res);
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

  if (req.method === 'GET' && req.url.startsWith('/events')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 1000\n\n');
    const eventsUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    eventClients.set(res, eventsUrl.searchParams.get('user') || '');

    req.on('close', () => {
      eventClients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/solicitudes') {
    try {
      const solicitudes = readJson(DATA_FILE);
      sendJson(res, 200, solicitudes.map(toPublicRequest));
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudieron leer las solicitudes.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/usuarios') {
    try {
      const data = await parseRequestBody(req);
      const name = String(data.name || '').trim();
      const google = String(data.google || '').trim().toLowerCase();
      const age = String(data.age || '').trim();
      const city = String(data.city || '').trim();

      if (!name || !google || !age || !city || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(google)) {
        sendJson(res, 400, { message: 'Los datos del perfil no son válidos.' });
        return;
      }

      const usuarios = readJson(USERS_FILE);
      const record = {
        id: `user-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        nombre: name,
        correo: google,
        edad: age,
        ciudad: city,
        ultimoIngreso: new Date().toISOString()
      };
      const existingIndex = usuarios.findIndex((user) => String(user.correo || '').toLowerCase() === google);

      if (existingIndex === -1) {
        usuarios.push(record);
      } else {
        usuarios[existingIndex] = { ...usuarios[existingIndex], ...record, id: usuarios[existingIndex].id };
      }

      writeJson(USERS_FILE, usuarios);
      sendJson(res, 200, { ok: true, message: 'Perfil guardado correctamente.' });
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudo guardar el perfil.', error: error.message });
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

      if (isEmpresa && (!data.nombre || !data.ciudad || !data.direccion || !data.mensaje || String(data.mensaje).trim().length < 30)) {
        sendJson(res, 400, { message: 'Faltan campos obligatorios de empresa.' });
        return;
      }

      if (isTrabajador && (!data.nombre || !data.distrito || !data.mensaje)) {
        sendJson(res, 400, { message: 'Faltan campos obligatorios de trabajador.' });
        return;
      }

      const photo = String(data.fotoLocal || '').trim();
      if (isEmpresa && photo && (!photo.startsWith('data:image/') || photo.length > 3 * 1024 * 1024)) {
        sendJson(res, 400, { message: 'La foto del local no es válida o supera el tamaño permitido.' });
        return;
      }

      const solicitudes = readJson(DATA_FILE);
      const record = {
        tipo: data.tipo,
        id: data.id || `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        nombre: String(data.nombre || '').trim(),
        rubro: String(data.rubro || '').trim(),
        region: String(data.region || '').trim(),
        distrito: String(data.distrito || '').trim(),
        direccion: String(data.direccion || '').trim(),
        ciudad: String(data.ciudad || '').trim(),
        mensaje: String(data.mensaje || '').trim(),
        horario: String(data.horario || '').trim(),
        fotoLocal: photo,
        createdBy: String(data.createdBy || data.nombre || '').trim(),
        fecha: data.fecha || new Date().toISOString()
      };

      solicitudes.push(record);
      writeJson(DATA_FILE, solicitudes);
      broadcastUpdate('catalog', { requests: solicitudes.map(toPublicRequest) });

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
      broadcastUpdate('catalog', { requests: solicitudes.map(toPublicRequest) });
      sendJson(res, 200, { ok: true, message: 'Solicitud eliminada.', data: deleted });
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudo eliminar la solicitud.', error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/chat')) {
    try {
      const chatUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const userName = chatUrl.searchParams.get('user') || '';
      const mensajes = readJson(CHAT_FILE).filter((message) => messageBelongsToUser(message, userName));
      sendJson(res, 200, mensajes);
    } catch (error) {
      sendJson(res, 500, { message: 'No se pudieron leer los mensajes.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/contacto') {
    try {
      const data = await parseRequestBody(req);
      const name = String(data.name || '').trim();
      const email = String(data.email || '').trim();
      const type = String(data.type || '').trim();
      const message = String(data.message || '').trim();
      const supportEmail = String(process.env.SUPPORT_EMAIL || '').trim();

      if (!name || !email || !type || !message || !supportEmail) {
        sendJson(res, 400, { message: 'Completa todos los campos del formulario.' });
        return;
      }

      await sendSupportEmail({ name, email, type, message, supportEmail });

      sendJson(res, 200, { ok: true, message: 'Reporte enviado correctamente.' });
    } catch (error) {
      console.error('Error SMTP:', {
        code: error.code,
        responseCode: error.responseCode,
        command: error.command,
        message: error.message
      });
      const message = error.code === 'RESEND_ERROR'
        ? `El servicio de correo rechazó el mensaje: ${error.message}`
        : error.code === 'MAIL_CONFIG'
          ? 'Falta configurar RESEND_API_KEY en Render.'
          : getMailErrorMessage(error);
      sendJson(res, 502, { message });
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