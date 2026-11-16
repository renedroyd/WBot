# Revocación de acceso desde SocialPublicator

WBot conserva sus perfiles locales y tokens de sesión cuando un administrador revoca una conexión en SocialPublicator. La revocación bloquea la autorización para consultar publicaciones, reclamar ejecuciones y actualizar el estado de esa cuenta.

- WhatsApp: el directorio WPPConnect y los tokens se conservan.
- Facebook: el perfil Chromium y las cookies se conservan.
- La instancia valida el código de revocación administrativa en el preflight antes de abrir sus sesiones.
- Si la conexión se reactiva desde SocialPublicator, puede ser necesario reiniciar WBot para que vuelva a informar el estado actual.
- Una desconexión natural del proveedor no se confunde con una revocación administrativa; el preflight solo bloquea los códigos de revocación emitidos por un administrador.

Este flujo no cierra sesión en WhatsApp ni Facebook, no elimina cookies y no borra archivos. Si se requiere cerrar sesión en el proveedor, debe hacerse como operación separada y deliberada.
