import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ShippingAddressDto } from './shipping.dto.js';

export const destinations = {
  FR: { label: 'France métropolitaine', fee: 590 },
  BE: { label: 'Belgique', fee: 990 },
  CA: { label: 'Canada', fee: 2490 },
} as const;

@Injectable()
export class ShippingService {
  constructor(private readonly config: ConfigService) {}

  options() {
    const provisional = this.config.get('SHIPPING_RATES_CONFIRMED') !== 'true';
    if (this.config.get('NODE_ENV') === 'production' && provisional)
      throw new ServiceUnavailableException('Les tarifs de livraison doivent être confirmés.');
    return {
      currency: 'eur' as const,
      provisional,
      destinations: (Object.keys(destinations) as Array<keyof typeof destinations>)
        .filter((country) => this.config.get(`SHIPPING_${country}_ENABLED`) !== 'false')
        .map((country) => {
          const configured = this.config.get<string>(`SHIPPING_${country}_CENTS`);
          if (this.config.get('NODE_ENV') === 'production' && configured === undefined)
            throw new ServiceUnavailableException('Tarif de livraison absent.');
          const fee = configured === undefined ? destinations[country].fee : Number(configured);
          if ((configured !== undefined && !/^\d+$/.test(configured)) || !Number.isSafeInteger(fee) || fee < 0 || fee > 100000)
            throw new ServiceUnavailableException('Tarif de livraison invalide.');
          return { country, label: destinations[country].label, fee };
        }),
    };
  }

  address(value: ShippingAddressDto) {
    if (!value) throw new BadRequestException('Adresse de livraison obligatoire.');
    // Printed on the parcel label and shown in the admin: no control characters or markup.
    const text = (input: string | undefined) => {
      const cleaned = (input ?? '').normalize('NFC').replace(/[ \t]+/g, ' ').trim();
      if (/[\p{Cc}\p{Cf}<>]/u.test(cleaned))
        throw new BadRequestException('Adresse de livraison invalide.');
      return cleaned;
    };
    const address = {
      line1: text(value.line1), line2: text(value.line2),
      city: text(value.city), postalCode: value.postalCode.replace(/\s+/g, '').toUpperCase(),
      region: value.country === 'CA' ? (value.region ?? '').trim().toUpperCase() : '',
      country: value.country,
    };
    const validPostal = address.country === 'FR'
      ? /^(0[1-9]|[1-8]\d|9[0-5])\d{3}$/.test(address.postalCode)
      : address.country === 'BE'
        ? /^[1-9]\d{3}$/.test(address.postalCode)
        : address.country === 'CA' && /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(address.postalCode)
          && ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'].includes(address.region);
    if (!validPostal) throw new BadRequestException('Code postal ou province invalide pour la destination.');
    if (address.line1.length < 3 || address.city.length < 2)
      throw new BadRequestException('Adresse de livraison incomplète.');
    if (address.country === 'CA') address.postalCode = address.postalCode.slice(0, 3) + ' ' + address.postalCode.slice(3);
    return address;
  }

  fee(country: ShippingAddressDto['country']) {
    const destination = this.options().destinations.find((item) => item.country === country);
    if (!destination) throw new BadRequestException('Livraison indisponible pour ce pays.');
    return destination.fee;
  }
}
