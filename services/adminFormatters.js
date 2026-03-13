const formatDate = (value) => {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
};

const formatDateTime = (value) => {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getPrimaryRole = (roles = []) => {
  if (!Array.isArray(roles) || roles.length === 0) return 'user';

  const preferred = roles.find((role) => role !== 'user');
  return preferred || roles[0];
};

const mapSimulationStatus = (status) => {
  if (status === 'processing') return 'running';
  return status;
};

const mapCommunityStatusToAdmin = (status) => {
  switch (status) {
    case 'active':
      return 'published';
    case 'flagged':
      return 'needs_review';
    case 'removed':
      return 'hidden';
    default:
      return status;
  }
};

const mapAdminStatusToCommunity = (status) => {
  switch (status) {
    case 'published':
      return 'active';
    case 'needs_review':
      return 'flagged';
    case 'hidden':
    case 'removed':
      return 'removed';
    default:
      return status;
  }
};

const buildExcerpt = (value = '', limit = 120) => {
  if (!value) return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trim()}...`;
};

module.exports = {
  buildExcerpt,
  formatDate,
  formatDateTime,
  getPrimaryRole,
  mapCommunityStatusToAdmin,
  mapAdminStatusToCommunity,
  mapSimulationStatus,
};
