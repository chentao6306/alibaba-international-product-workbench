import path from 'node:path';

export function registerAdminPages(app, { directory, adminPath = process.env.KUA_YIPU_ADMIN_PATH || '/admin' }) {
  const entry = adminPath.replace(/\/$/, '');
  if (!/^\/[a-zA-Z0-9][a-zA-Z0-9_-]{2,100}$/.test(entry) || /^\/(api|website|updates|health)$/i.test(entry)) {
    throw new Error('KUA_YIPU_ADMIN_PATH must be a distinct single path segment');
  }
  app.get('/', (_request, response) => response.redirect(302, '/website/'));
  app.get(new RegExp(`^${entry}/?$`), (request, response) => {
    response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (!request.path.endsWith('/')) return response.redirect(308, `${entry}/`);
    response.sendFile(path.join(directory, 'admin.html'));
  });
  for (const file of ['admin.js', 'admin.css', 'admin-updates.js', 'admin-announcements.js', 'admin-image-upload.js', 'announcement-content.js', 'admin-bulk-licenses.js', 'admin-diagnostics.js']) {
    app.get(`${entry}/${file}`, (_request, response) => {
      response.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      response.sendFile(path.join(directory, file));
    });
  }
}
