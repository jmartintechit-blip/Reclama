import { REPO_URL } from '../components/Layout.tsx';

export function Privacy() {
  return (
    <div className="wrap prose">
      <title>Privacidad · Reclama</title>
      <h1>Privacidad</h1>
      <p className="lede">
        Reclama es un proyecto de portafolio. Esta página dice, sin letra
        pequeña, qué datos se guardan y dónde.
      </p>

      <h2>Qué datos se guardan</h2>
      <ul>
        <li>Tu correo electrónico.</li>
        <li>
          Tu contraseña, pero solo como un hash (argon2id): una huella a partir
          de la cual no se puede recuperar la contraseña.
        </li>
        <li>El perfil de tu negocio.</li>
        <li>Tus deudores y tus facturas, con sus cobros.</li>
      </ul>

      <h2>Cookies y rastreo</h2>
      <p>
        Reclama usa una única cookie, la de sesión, imprescindible para
        mantenerte identificado cuando entras. No hay analítica, publicidad ni
        rastreadores, y esta página no hace peticiones a servicios de terceros:
        hasta las tipografías se sirven desde el propio sitio.
      </p>

      <h2>Dónde se alojan los datos</h2>
      <p>
        La base de datos está en Neon y la web y la API en Netlify. Ambos
        servicios tienen sus servidores en Estados Unidos, así que tus datos se
        guardan fuera de la Unión Europea. Si envías un requerimiento por correo
        desde Reclama, el mensaje se entrega a través de Resend, que recibe la
        dirección del destinatario y el texto.
      </p>

      <h2>Borrar tus datos</h2>
      <p>
        Podrás borrar tu cuenta y todos tus datos desde la pantalla de perfil
        cuando esté disponible.
      </p>

      <h2>La demo</h2>
      <p>La demo usa datos ficticios y se borra pasadas 24 horas.</p>

      <h2>Datos de otras personas</h2>
      <p>
        Mientras Reclama sea un proyecto de portafolio, no introduzcas datos
        personales reales de otras personas (por ejemplo, de tus deudores). Usa
        datos de prueba.
      </p>

      <h2>Contacto</h2>
      <p>
        Para cualquier duda, abre una incidencia en el{' '}
        <a href={`${REPO_URL}/issues`}>repositorio de GitHub</a>. Las
        incidencias son públicas: no escribas en ellas datos personales.
      </p>
    </div>
  );
}
