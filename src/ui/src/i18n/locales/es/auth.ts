import type { auth as zh } from '../zh/auth';
export const auth: typeof zh = {
  sessionExpired: 'Tu sesión ha caducado. Inicia sesión de nuevo.', restoring: 'Restaurando tu sesión…', brand: 'Clawpage Agent',
  heading: { login: 'Pon tu IA a trabajar', register: 'Conoce a tu Clawpage Agent', invite: 'Solo falta una invitación' },
  passwordAlternative: 'o usa tu correo y contraseña',
  intro: { openRegistration: "Las primeras 20 cuentas pueden registrarse sin invitación. Después se requiere un código de invitación.", login: 'Retoma el trabajo con tu asistente de IA.', register: 'Crea una cuenta y pon a trabajar a tu asistente de IA.' },
  fields: { email: 'Correo electrónico', emailHint: 'nombre@ejemplo.com', signInHint: 'Correo (o tu usuario anterior)', password: 'Contraseña', passwordHint: 'Introduce tu contraseña', newPasswordHint: 'Al menos 12 caracteres', confirm: 'Confirmar contraseña', confirmHint: 'Vuelve a introducir la contraseña', inviteCode: 'Código de invitación' },
  passwordMismatch: 'Las contraseñas no coinciden',
  google: { activateOpen: "Registrarse y continuar", button: 'Acceder o registrarse con Google', inviteIntro: 'Introduce un código de invitación para activar tu primera visita.', verified: 'Cuenta de Google verificada', waiting: 'Termina de acceder con Google en el navegador y vuelve a la aplicación.', failed: 'El acceso con Google no se completó o ha caducado. Inténtalo de nuevo.', activate: 'Verificar invitación y continuar', activating: 'Verificando…', cancel: 'Usar otro método de acceso', retry: 'Volver a acceder con Google' },
  invite: { quotaReached: "Las plazas sin invitación se han agotado. Introduce un código de invitación.", askBefore: '¿Necesitas una invitación? Escribe a ', askAfter: ' para solicitarla.', mailSubject: 'Solicitud de código de invitación de Clawpage Agent', askAdmin: 'Pide un código de invitación a tu administrador. Cada código permite registrar una cuenta.' },
  sessionUnverified: 'No podemos verificar tu sesión ahora. Lo volveremos a intentar cuando tengas conexión.',
  /** The console opened without reaching the server (no network, or the service is down). */
  offline: { title: 'No se puede conectar con Clawpage Agent', noNetwork: 'Este dispositivo no tiene conexión. La app se abrirá sola cuando vuelvas a estar en línea.', unreachable: 'No se puede conectar con el servidor ahora. La app se abrirá sola cuando vuelva.', retry: 'Reintentar' },
  submit: { register: 'Registrarse e iniciar sesión', registering: 'Registrando…', login: 'Iniciar sesión', loggingIn: 'Iniciando sesión…' },
  switch: { haveAccount: '¿Ya tienes una cuenta? ', noAccount: '¿No tienes cuenta? ', toLogin: 'Inicia sesión', toRegister: "Crear una cuenta" },
  foreign: { title: (owner: string) => `Esta página pertenece a ${owner}`, body: (current: string) => `Has iniciado sesión como ${current}. Un navegador solo puede usar una cuenta a la vez.`, switchTo: (owner: string) => `Cerrar sesión y acceder como ${owner}`, backHome: 'Volver a mi página' },
};
