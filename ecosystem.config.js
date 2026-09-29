module.exports = {
  apps : [{
    script: 'app.js',
    instances: 1,
    autorestart: true,
    watch: ["app.js","config","locales","res","routes","service","utils","templates","middleware"],
    ignore_watch: ["node_modules","logs/*","sql/*","static/*","uploads/*",]
  }]
}; 
