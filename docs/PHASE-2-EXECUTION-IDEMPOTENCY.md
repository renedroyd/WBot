# WBot — Fase 2: reclamación exclusiva e idempotencia

## Regla de seguridad

WBot solo puede enviar una publicación si SocialPublicator responde explícitamente
`claimed: true` y el registro está en estado `running`. Una respuesta HTTP fallida,
vacía o ambigua cancela el envío.

Si el registro ya está `succeeded`, WBot actualiza su estado local sin volver a
publicar. Si está `running` pero no fue reclamado por esta petición, o está
`unknown`, el agente no envía nada.

## Resultado incierto

Cuando el flujo de Facebook confirma que se hizo clic en Publicar pero no puede
verificar el resultado, WBot informa `outcome_unknown=true`. SocialPublicator cambia
la ejecución a `unknown`. Este estado no se reclama automáticamente en posteriores
intentos: debe reconciliarse antes de decidir si se reintenta.

## Responsabilidades integradas

- Dubai-Shop continúa siendo la fuente de catálogo, precios y disponibilidad.
- SocialPublicator mantiene la ejecución por ocurrencia y destino, controla la
  reclamación atómica y es la autoridad del estado.
- WBot ejecuta únicamente después de recibir la concesión exclusiva.

La entrega a WhatsApp sigue usando WPPConnect. La entrega a grupos de Facebook sigue
usando el perfil de navegador persistente de WBot. La autenticación oficial de páginas
Meta permanece en SocialPublicator.

## Pruebas

La suite de WBot cubre concesión explícita, ejecuciones ya exitosas, ejecuciones
reclamadas por otro intento, estados inciertos y fallos de respuesta. SocialPublicator
prueba la reclamación única, la transición a `unknown` y la reconciliación posterior.
