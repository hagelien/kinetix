declare module 'plotly.js-basic-dist-min' {
  export interface PlotData {
    x?: (number | string)[];
    y?: (number | string)[];
    type?: 'scatter' | 'bar' | 'pie' | 'heatmap' | 'histogram';
    mode?: 'lines' | 'markers' | 'lines+markers' | 'text' | 'none';
    name?: string;
    line?: {
      color?: string;
      width?: number;
      dash?: 'solid' | 'dot' | 'dash' | 'longdash' | 'dashdot' | 'longdashdot';
    };
    marker?: {
      color?: string | string[];
      size?: number | number[];
    };
    hovertemplate?: string;
    hoverinfo?: string;
    text?: string[];
    textposition?: string;
    fill?: 'tozeroy' | 'tozerox' | 'tonexty' | 'tonextx' | 'toself' | 'tonext';
    fillcolor?: string;
    legendgroup?: string;
    showlegend?: boolean;
    yaxis?: string;
  }

  export interface Layout {
    title?: string | { text?: string; font?: { size?: number; color?: string } };
    xaxis?: {
      title?: string | { text?: string; font?: { size?: number } };
      gridcolor?: string;
      linecolor?: string;
      zerolinecolor?: string;
      range?: [number, number];
      type?: 'linear' | 'log' | 'date' | 'category';
    };
    yaxis?: {
      title?: string | { text?: string; font?: { size?: number } };
      gridcolor?: string;
      linecolor?: string;
      zerolinecolor?: string;
      range?: [number, number];
      type?: 'linear' | 'log' | 'date' | 'category';
    };
    paper_bgcolor?: string;
    plot_bgcolor?: string;
    margin?: { t?: number; r?: number; b?: number; l?: number };
    showlegend?: boolean;
    legend?: {
      x?: number;
      y?: number;
      xanchor?: 'left' | 'center' | 'right' | 'auto';
      bgcolor?: string;
    };
    hovermode?: 'closest' | 'x' | 'y' | 'x unified' | 'y unified' | false;
    annotations?: Array<{
      text?: string;
      xref?: string;
      yref?: string;
      x?: number;
      y?: number;
      showarrow?: boolean;
      font?: { size?: number; color?: string };
    }>;
  }

  export interface Config {
    responsive?: boolean;
    displayModeBar?: boolean;
    modeBarButtonsToRemove?: string[];
    displaylogo?: boolean;
    staticPlot?: boolean;
    scrollZoom?: boolean;
  }

  export interface PlotlyHTMLElement extends HTMLElement {
    data: PlotData[];
    layout: Layout;
    on(event: string, callback: (data: unknown) => void): void;
  }

  export function newPlot(
    root: HTMLElement | string,
    data: Partial<PlotData>[],
    layout?: Partial<Layout>,
    config?: Partial<Config>
  ): Promise<PlotlyHTMLElement>;

  export function react(
    root: HTMLElement | string,
    data: Partial<PlotData>[],
    layout?: Partial<Layout>,
    config?: Partial<Config>
  ): Promise<PlotlyHTMLElement>;

  export function purge(root: HTMLElement | string): void;

  export function relayout(root: HTMLElement | string, layout: Partial<Layout>): Promise<PlotlyHTMLElement>;

  export function restyle(root: HTMLElement | string, data: Partial<PlotData>, traces?: number[]): Promise<PlotlyHTMLElement>;
}
