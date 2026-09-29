const path = require('path');

module.exports = {
  rootDir: path.join(process.cwd(), 'uploads'),
  publicBasePath: '/uploads',
  naming: {
    keepExtension: true,
    useOriginalBaseName: false
  },
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
    files: 20,
    fields: 100,
    parts: 120
  },
  defaultRule: {
    subDir: 'common',
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/csv',
      'application/vnd.ms-excel',
      'text/plain'
    ],
    allowedExtensions: [
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.csv', '.txt'
    ],
    fields: null, // null 이면 모든 file field 허용
    maxFilesPerField: 10
  },

  rules: [
    {
      test: /^\/mgr\/content/,
      subDir: function (req) {
        return 'content/' + (req.params.menuId || 'common');
      },
      allowedMimeTypes: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/pdf'
      ],
      allowedExtensions: [
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'
      ],
      fields: {
        thumbnail: 1,
        attachments: 10
      },
      maxFilesPerField: 10
    },
  ]
};