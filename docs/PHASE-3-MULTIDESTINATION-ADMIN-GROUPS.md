# WBot — Fase 3: multidestino y grupos administrados

## Multidestino

Una publicación puede contener varios grupos de WhatsApp y varios grupos de Facebook.
SocialPublicator devuelve únicamente los destinos seleccionados y autorizados en el
workspace. WBot mantiene el procesamiento de WhatsApp secuencial y la cola de Facebook
con concurrencia limitada, con una ejecución independiente por ocurrencia y destino.

## Grupos de WhatsApp administrados por la cuenta conectada

Durante la sincronización WBot obtiene la identidad actual de la cuenta de WhatsApp
(WID y, cuando está disponible, LID) y compara esa identidad con los participantes
del metadata del grupo. Solo envía `is_admin` cuando la comprobación es verificable.
Si faltan identidad o metadata, no inventa el permiso ni reemplaza un estado previamente
verificado.

SocialPublicator persiste `is_admin` y `admin_checked_at`. El formulario de publicación
solo ofrece grupos con `is_admin=true`; los grupos no administrados o no verificados no
son destinos seleccionables. Esto complementa los permisos por cuenta y destino del
workspace: ser administrador de WhatsApp no sustituye la autorización interna de
SocialPublicator.

## Separación de responsabilidades

- Dubai-Shop: catálogo, variantes, precios y disponibilidad de productos.
- SocialPublicator: campañas, programación, publicaciones, selección de grupos,
  permisos y estado de ejecuciones.
- WBot: sincronización de metadatos de grupos y ejecución de entregas autorizadas.

WhatsApp sigue usando WPPConnect. Facebook Groups sigue usando el perfil persistente
de navegador de WBot; las páginas de Facebook se publican por el flujo oficial OAuth/API
gestionado por SocialPublicator.

## Criterios de salida

- Se entregan todos los grupos seleccionados y autorizados.
- Cada grupo tiene su propia ejecución e idempotencia.
- Solo se ofrecen grupos de WhatsApp donde la cuenta conectada es administradora.
- WhatsApp permanece secuencial; Facebook conserva la cola concurrente limitada.
