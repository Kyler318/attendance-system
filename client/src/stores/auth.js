import { defineStore } from 'pinia';
import http from '../api/http';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    loaded: false,
  }),
  getters: {
    isAdmin: (state) => state.user?.role === 'admin',
    isTeacher: (state) => state.user?.role === 'teacher',
  },
  actions: {
    async fetchMe() {
      try {
        const { data } = await http.get('/auth/me');
        this.user = data;
      } catch {
        this.user = null;
      } finally {
        this.loaded = true;
      }
    },
    async login(username, password, rememberMe) {
      const { data } = await http.post('/auth/login', { username, password, rememberMe });
      this.user = data;
      return data;
    },
    async logout() {
      await http.post('/auth/logout');
      this.user = null;
    },
  },
});
