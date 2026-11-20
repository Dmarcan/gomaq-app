import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const gomaq = github("Dmarcan/gomaq-app", { checkSuites: true });

  const Postgres = postgres("Postgres", { region: "us-east4-eqdc4a" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  // estado actual en Railway: la base se duerme sin trafico (ojo: el worker la mantiene despierta)
  Postgres.deploy = { sleepApplication: true };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const gomaqApp = service("gomaq-app", {
    source: gomaq,
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: {
      sleepApplication: true,
      healthcheckPath: "/api/health",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      DATABASE_URL: preserve(),
      JWT_SECRET: preserve(),
      SUPABASE_SERVICE_KEY: preserve(),
      SUPABASE_URL: preserve(),
      TRUST_PROXY: preserve(),
      // ya existian en Railway sin estar declaradas: un `apply` las habria borrado
      NOTIFICACIONES_EN_PROCESO: preserve(),
      ORS_API_KEY: preserve(),
      // correo de invitacion y recuperar contrasena (se envian desde la API, no por el worker);
      // son referencias a las del servicio gomaq-worker
      RESEND_API_KEY: preserve(),
      CORREO_REMITENTE: preserve(),
      CORREO_CONTACTO: preserve(),
      // push (FCM): flag que enciende el encolado de push, y la configuracion publica de Firebase que el Dockerfile
      // usa como argumentos de build del panel web (no son secretos)
      PUSH_HABILITADO: preserve(),
      FIREBASE_API_KEY: preserve(),
      FIREBASE_APP_ID: preserve(),
      FIREBASE_MESSAGING_SENDER_ID: preserve(),
      FIREBASE_PROJECT_ID: preserve(),
      FIREBASE_VAPID_KEY: preserve(),
    },
  });
  // Worker de notificaciones: mismo repo, sin HTTP (sin healthcheck ni dominio) y siempre activo.
  // Solo se redespliega si cambia el backend, la base o su propio Dockerfile.
  const gomaqWorker = service("gomaq-worker", {
    source: gomaq,
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.worker",
      watchPatterns: ["/backend/**", "/db/**", "/Dockerfile.worker"],
    },
    deploy: { restartPolicyType: "ALWAYS" },
    replicas: { "us-east4-eqdc4a": 1 },
    // RESEND_API_KEY, SUPABASE_* (para adjuntar el PDF) y los datos del correo de facturas: los valores viven en Railway
    env: {
      DATABASE_URL: preserve(),
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: preserve(),
      RESEND_API_KEY: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_SERVICE_KEY: preserve(),
      CORREO_REMITENTE: preserve(),
      CORREO_CONTACTO: preserve(),
      // cuenta de servicio de Firebase (JSON en base64) para enviar push: secreto, el valor vive solo en Railway
      FCM_CUENTA_SERVICIO: preserve(),
    },
  });

  return project("gomaq", {
    resources: [gomaqApp, Postgres, gomaqWorker, postgresVolume],
  });
});
