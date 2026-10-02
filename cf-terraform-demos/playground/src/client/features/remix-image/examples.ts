/**
 * Prepared preservation-aware instructions for reference-image editing.
 */
export interface RemixExample {
  /**
   * Stable list key.
   */
  id: string;
  /**
   * Short pill label.
   */
  label: string;
  /**
   * Full instruction loaded into the editor.
   */
  instruction: string;
  /**
   * Teaching purpose exposed as tooltip text.
   */
  teaches: string;
}

/**
 * Examples explicitly tell the model which source structure must survive the style edit.
 */
export const REMIX_EXAMPLES: readonly RemixExample[] = [
  {
    id: 'watercolor',
    label: 'Watercolor',
    instruction:
      'Restyle the provided image as a watercolor painting, preserving the major subjects, composition, lighting, and positions of objects in the image.',
    teaches: 'Changes the medium while explicitly preserving the source composition.'
  },
  {
    id: 'travel-poster',
    label: 'Travel poster',
    instruction:
      'Restyle the provided image as a vintage travel poster, preserving the major subjects, composition, and recognizable details of the original image.',
    teaches: 'Asks for a graphic style without replacing the source scene.'
  },
  {
    id: 'charcoal',
    label: 'Charcoal sketch',
    instruction:
      'Restyle the provided image as a detailed charcoal sketch, preserving the major subjects, composition, silhouettes, and positions of objects in the image.',
    teaches: 'Makes preservation requirements explicit for a monochrome medium.'
  }
];
