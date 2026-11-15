import { mount, type ComponentMountingOptions } from '@vue/test-utils';
import type { Component } from 'vue';
import { i18n } from '../src/i18n';

/** Mounts a component with the texts plugin, as in the app. */
export function mountWithI18n<T extends Component>(component: T, options: ComponentMountingOptions<T> = {}) {
  return mount(component, { ...options, global: { ...options.global, plugins: [i18n, ...(options.global?.plugins ?? [])] } });
}
