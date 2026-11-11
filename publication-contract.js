'use strict';

/**
 * Normalizes the versioned SocialPublicator bot publication contract to the
 * legacy internal shape consumed by the existing WBot delivery pipeline.
 * Keeps original fields so diagnostics and future channels can use them.
 */
function normalizePublication(publication) {
    if (!publication || typeof publication !== 'object' || Array.isArray(publication)) {
        return publication;
    }

    const occurrenceId = publication.occurrence_id ?? publication.ocurrencia_id;
    const date = publication.date ?? publication.fecha;
    const time = publication.time ?? publication.hora;
    const text = publication.text ?? publication.texto;
    const image = publication.image ?? publication.imagen;
    const destination = publication.destination ?? publication.destino;

    return {
        ...publication,
        occurrence_id: occurrenceId,
        ocurrencia_id: occurrenceId,
        date,
        fecha: date,
        time,
        hora: time,
        text,
        texto: text,
        image,
        imagen: image,
        destination,
        destino: destination,
        whatsapp_groups: publication.whatsapp_groups ?? publication.whatsappGroups ?? publication.whatsapp_grupos ?? publication.whatsappGrupos,
        facebook_groups: publication.facebook_groups ?? publication.facebookGroups ?? publication.facebook_grupos ?? publication.facebookGrupos,
    };
}

module.exports = { normalizePublication };
