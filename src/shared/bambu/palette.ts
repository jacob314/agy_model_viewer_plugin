export type BambuLine = 'PLA Basic' | 'PLA Matte' | 'PLA Silk+';
export type BambuPaletteScope = 'basic-matte' | 'matte' | 'basic' | 'all';

export interface BambuFilament {
  id: string;
  line: BambuLine;
  name: string;
  hex: string;
  roughness: number;
  metalness: number;
}

const BASIC_PBR = { roughness: 0.42, metalness: 0.04 };
const MATTE_PBR = { roughness: 0.82, metalness: 0.0 };
const SILK_PBR = { roughness: 0.24, metalness: 0.28 };

/**
 * Official Bambu Lab PLA Basic, PLA Matte, and PLA Silk+ filament hex tables.
 */
export const BAMBU_FILAMENTS: BambuFilament[] = [
  // --- Bambu Lab PLA Basic (30 colors) ---
  { id: 'basic-jade-white', line: 'PLA Basic', name: 'Jade White', hex: '#FFFFFF', ...BASIC_PBR },
  { id: 'basic-beige', line: 'PLA Basic', name: 'Beige', hex: '#F7E6DE', ...BASIC_PBR },
  { id: 'basic-light-gray', line: 'PLA Basic', name: 'Light Gray', hex: '#D1D3D5', ...BASIC_PBR },
  { id: 'basic-silver', line: 'PLA Basic', name: 'Silver', hex: '#A6A9AA', ...BASIC_PBR },
  { id: 'basic-gray', line: 'PLA Basic', name: 'Gray', hex: '#8E9089', ...BASIC_PBR },
  { id: 'basic-magenta', line: 'PLA Basic', name: 'Magenta', hex: '#EC008C', ...BASIC_PBR },
  { id: 'basic-pink', line: 'PLA Basic', name: 'Pink', hex: '#F55A74', ...BASIC_PBR },
  { id: 'basic-hot-pink', line: 'PLA Basic', name: 'Hot Pink', hex: '#F5547C', ...BASIC_PBR },
  { id: 'basic-orange', line: 'PLA Basic', name: 'Orange', hex: '#FF6A13', ...BASIC_PBR },
  { id: 'basic-pumpkin-orange', line: 'PLA Basic', name: 'Pumpkin Orange', hex: '#FF9016', ...BASIC_PBR },
  { id: 'basic-gold', line: 'PLA Basic', name: 'Gold', hex: '#E4BD68', ...BASIC_PBR },
  { id: 'basic-sunflower-yellow', line: 'PLA Basic', name: 'Sunflower Yellow', hex: '#FEC600', ...BASIC_PBR },
  { id: 'basic-yellow', line: 'PLA Basic', name: 'Yellow', hex: '#F4EE2A', ...BASIC_PBR },
  { id: 'basic-bright-green', line: 'PLA Basic', name: 'Bright Green', hex: '#BECF00', ...BASIC_PBR },
  { id: 'basic-bambu-green', line: 'PLA Basic', name: 'Bambu Green', hex: '#00AE42', ...BASIC_PBR },
  { id: 'basic-mistletoe-green', line: 'PLA Basic', name: 'Mistletoe Green', hex: '#3F8E43', ...BASIC_PBR },
  { id: 'basic-bronze', line: 'PLA Basic', name: 'Bronze', hex: '#847D48', ...BASIC_PBR },
  { id: 'basic-cocoa-brown', line: 'PLA Basic', name: 'Cocoa Brown', hex: '#6F5034', ...BASIC_PBR },
  { id: 'basic-brown', line: 'PLA Basic', name: 'Brown', hex: '#9D432C', ...BASIC_PBR },
  { id: 'basic-maroon-red', line: 'PLA Basic', name: 'Maroon Red', hex: '#9D2235', ...BASIC_PBR },
  { id: 'basic-red', line: 'PLA Basic', name: 'Red', hex: '#C12E1F', ...BASIC_PBR },
  { id: 'basic-turquoise', line: 'PLA Basic', name: 'Turquoise', hex: '#00B1B7', ...BASIC_PBR },
  { id: 'basic-cyan', line: 'PLA Basic', name: 'Cyan', hex: '#0086D6', ...BASIC_PBR },
  { id: 'basic-blue', line: 'PLA Basic', name: 'Blue', hex: '#0A2989', ...BASIC_PBR },
  { id: 'basic-cobalt-blue', line: 'PLA Basic', name: 'Cobalt Blue', hex: '#0056B8', ...BASIC_PBR },
  { id: 'basic-purple', line: 'PLA Basic', name: 'Purple', hex: '#5E43B7', ...BASIC_PBR },
  { id: 'basic-indigo-purple', line: 'PLA Basic', name: 'Indigo Purple', hex: '#482960', ...BASIC_PBR },
  { id: 'basic-blue-grey', line: 'PLA Basic', name: 'Blue Grey', hex: '#5B6579', ...BASIC_PBR },
  { id: 'basic-dark-gray', line: 'PLA Basic', name: 'Dark Gray', hex: '#545454', ...BASIC_PBR },
  { id: 'basic-black', line: 'PLA Basic', name: 'Black', hex: '#000000', ...BASIC_PBR },

  // --- Bambu Lab PLA Matte (25 colors) ---
  { id: 'matte-ivory-white', line: 'PLA Matte', name: 'Ivory White', hex: '#FFFFFF', ...MATTE_PBR },
  { id: 'matte-bone-white', line: 'PLA Matte', name: 'Bone White', hex: '#CBC6B8', ...MATTE_PBR },
  { id: 'matte-desert-tan', line: 'PLA Matte', name: 'Desert Tan', hex: '#E8DBB7', ...MATTE_PBR },
  { id: 'matte-latte-brown', line: 'PLA Matte', name: 'Latte Brown', hex: '#D3B7A7', ...MATTE_PBR },
  { id: 'matte-caramel', line: 'PLA Matte', name: 'Caramel', hex: '#AE835B', ...MATTE_PBR },
  { id: 'matte-terracotta', line: 'PLA Matte', name: 'Terracotta', hex: '#B15533', ...MATTE_PBR },
  { id: 'matte-dark-brown', line: 'PLA Matte', name: 'Dark Brown', hex: '#7D6556', ...MATTE_PBR },
  { id: 'matte-dark-chocolate', line: 'PLA Matte', name: 'Dark Chocolate', hex: '#4D3324', ...MATTE_PBR },
  { id: 'matte-lilac-purple', line: 'PLA Matte', name: 'Lilac Purple', hex: '#AE96D4', ...MATTE_PBR },
  { id: 'matte-sakura-pink', line: 'PLA Matte', name: 'Sakura Pink', hex: '#E8AFCF', ...MATTE_PBR },
  { id: 'matte-mandarin-orange', line: 'PLA Matte', name: 'Mandarin Orange', hex: '#F99963', ...MATTE_PBR },
  { id: 'matte-lemon-yellow', line: 'PLA Matte', name: 'Lemon Yellow', hex: '#F7D959', ...MATTE_PBR },
  { id: 'matte-plum', line: 'PLA Matte', name: 'Plum', hex: '#950051', ...MATTE_PBR },
  { id: 'matte-scarlet-red', line: 'PLA Matte', name: 'Scarlet Red', hex: '#DE4343', ...MATTE_PBR },
  { id: 'matte-dark-red', line: 'PLA Matte', name: 'Dark Red', hex: '#BB3D43', ...MATTE_PBR },
  { id: 'matte-dark-green', line: 'PLA Matte', name: 'Dark Green', hex: '#68724D', ...MATTE_PBR },
  { id: 'matte-grass-green', line: 'PLA Matte', name: 'Grass Green', hex: '#61C680', ...MATTE_PBR },
  { id: 'matte-apple-green', line: 'PLA Matte', name: 'Apple Green', hex: '#C2E189', ...MATTE_PBR },
  { id: 'matte-ice-blue', line: 'PLA Matte', name: 'Ice Blue', hex: '#A3D8E1', ...MATTE_PBR },
  { id: 'matte-sky-blue', line: 'PLA Matte', name: 'Sky Blue', hex: '#56B7E6', ...MATTE_PBR },
  { id: 'matte-marine-blue', line: 'PLA Matte', name: 'Marine Blue', hex: '#0078BF', ...MATTE_PBR },
  { id: 'matte-dark-blue', line: 'PLA Matte', name: 'Dark Blue', hex: '#042F56', ...MATTE_PBR },
  { id: 'matte-ash-gray', line: 'PLA Matte', name: 'Ash Gray', hex: '#9B9EA0', ...MATTE_PBR },
  { id: 'matte-nardo-gray', line: 'PLA Matte', name: 'Nardo Gray', hex: '#757575', ...MATTE_PBR },
  { id: 'matte-charcoal', line: 'PLA Matte', name: 'Charcoal', hex: '#000000', ...MATTE_PBR },

  // --- Bambu Lab PLA Silk+ (13 colors) ---
  { id: 'silk-white', line: 'PLA Silk+', name: 'Silk White', hex: '#FFFFFF', ...SILK_PBR },
  { id: 'silk-silver', line: 'PLA Silk+', name: 'Silk Silver', hex: '#C8C8C8', ...SILK_PBR },
  { id: 'silk-champagne', line: 'PLA Silk+', name: 'Champagne', hex: '#F3CFB2', ...SILK_PBR },
  { id: 'silk-pink', line: 'PLA Silk+', name: 'Silk Pink', hex: '#F7ADA6', ...SILK_PBR },
  { id: 'silk-rose-gold', line: 'PLA Silk+', name: 'Rose Gold', hex: '#BA9594', ...SILK_PBR },
  { id: 'silk-candy-red', line: 'PLA Silk+', name: 'Candy Red', hex: '#D02727', ...SILK_PBR },
  { id: 'silk-gold', line: 'PLA Silk+', name: 'Silk Gold', hex: '#F4A925', ...SILK_PBR },
  { id: 'silk-mint', line: 'PLA Silk+', name: 'Silk Mint', hex: '#96DCB9', ...SILK_PBR },
  { id: 'silk-candy-green', line: 'PLA Silk+', name: 'Candy Green', hex: '#018814', ...SILK_PBR },
  { id: 'silk-baby-blue', line: 'PLA Silk+', name: 'Baby Blue', hex: '#A8C6EE', ...SILK_PBR },
  { id: 'silk-blue', line: 'PLA Silk+', name: 'Silk Blue', hex: '#008BDA', ...SILK_PBR },
  { id: 'silk-purple', line: 'PLA Silk+', name: 'Silk Purple', hex: '#8671CB', ...SILK_PBR },
  { id: 'silk-titan-gray', line: 'PLA Silk+', name: 'Titan Gray', hex: '#5F6367', ...SILK_PBR },
];

export function getFilamentsForScope(scope: BambuPaletteScope): BambuFilament[] {
  switch (scope) {
    case 'matte':
      return BAMBU_FILAMENTS.filter((f) => f.line === 'PLA Matte');
    case 'basic':
      return BAMBU_FILAMENTS.filter((f) => f.line === 'PLA Basic');
    case 'all':
      return BAMBU_FILAMENTS;
    case 'basic-matte':
    default:
      return BAMBU_FILAMENTS.filter((f) => f.line === 'PLA Basic' || f.line === 'PLA Matte');
  }
}
