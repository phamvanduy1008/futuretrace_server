const express = require('express');
const auth = require('../middleware/auth');
const CommunityPost = require('../models/CommunityPost');
const CommunityComment = require('../models/CommunityComment');
const CommunityLike = require('../models/CommunityLike');
const User = require('../models/User');

const router = express.Router();

// GET /api/community/posts - List community posts with pagination, filter, search
router.get('/posts', auth, async (req, res) => {
  try {
    const { page = 1, limit = 3, filter = 'all', q = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { status: 'active' };

    if (filter && filter !== 'all') {
      // Map filter to type field (positive -> Positive, neutral -> Neutral, risk -> Risk)
      const typeMap = { positive: 'Positive', neutral: 'Neutral', risk: 'Risk' };
      if (typeMap[filter.toLowerCase()]) {
        query.type = typeMap[filter.toLowerCase()];
      }
    }

    if (q) {
      query.$or = [
        { title: { $regex: q, $options: 'i' } },
        { content: { $regex: q, $options: 'i' } }
      ];
    }

    const [posts, total] = await Promise.all([
      CommunityPost.find(query)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('user_id', 'full_name avatar_url'),
      CommunityPost.countDocuments(query)
    ]);

    // Check if user has liked each post
    const postIds = posts.map(p => p._id);
    const userLikes = await CommunityLike.find({
      post_id: { $in: postIds },
      user_id: req.user.userId
    });
    const likedPostIds = new Set(userLikes.map(l => l.post_id.toString()));

    const formatted = posts.map(post => {
      const author = post.user_id;
      return {
        id: post._id.toString(),
        author: post.is_anonymous ? 'Người dùng ẩn danh' : (author?.full_name || 'Unknown'),
        authorAvatar: post.is_anonymous ? null : (author?.avatar_url || null),
        isAnonymous: post.is_anonymous,
        date: post.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
        title: post.title,
        desc: post.content,
        description: post.content,
        type: post.type,
        category: post.category,
        careerGrowth: post.career_growth,
        happiness: post.happiness,
        roi: post.roi,
        likes: post.likes_count,
        commentsCount: post.comments_count,
        reliability: post.reliability,
        deepAnalysis: post.deep_analysis,
        isLiked: likedPostIds.has(post._id.toString())
      };
    });

    res.json({
      items: formatted,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (error) {
    console.error('Get community posts error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// POST /api/community/posts - Publish a scenario to community
router.post('/posts', auth, async (req, res) => {
  try {
    const { title, content, category, is_anonymous, type, career_growth, happiness, roi, reliability, deep_analysis, scenario_id } = req.body;

    if (!title || !content) {
      return res.status(400).json({ message: 'Tiêu đề và nội dung là bắt buộc.' });
    }

    const post = new CommunityPost({
      user_id: req.user.userId,
      title,
      content,
      category: category || 'SỰ NGHIỆP',
      is_anonymous: is_anonymous || false,
      type: type || 'Positive',
      career_growth: career_growth || 0,
      happiness: happiness || 0,
      roi: roi || 0,
      reliability: reliability || 95,
      deep_analysis: deep_analysis || null,
      scenario_id: scenario_id || null
    });

    await post.save();

    const user = await User.findById(req.user.userId).select('full_name avatar_url');

    res.status(201).json({
      id: post._id.toString(),
      author: post.is_anonymous ? 'Người dùng ẩn danh' : (user?.full_name || 'Unknown'),
      authorAvatar: post.is_anonymous ? null : (user?.avatar_url || null),
      isAnonymous: post.is_anonymous,
      date: post.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      title: post.title,
      desc: post.content,
      type: post.type,
      category: post.category,
      careerGrowth: post.career_growth,
      happiness: post.happiness,
      roi: post.roi,
      likes: 0,
      commentsCount: 0,
      reliability: post.reliability,
      deepAnalysis: post.deep_analysis
    });
  } catch (error) {
    console.error('Create community post error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// POST /api/community/posts/:id/like - Toggle like
router.post('/posts/:id/like', auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.userId;

    const existingLike = await CommunityLike.findOne({ post_id: postId, user_id: userId });

    if (existingLike) {
      // Unlike
      await CommunityLike.deleteOne({ _id: existingLike._id });
      await CommunityPost.findByIdAndUpdate(postId, { $inc: { likes_count: -1 } });
      res.json({ liked: false });
    } else {
      // Like
      await new CommunityLike({ post_id: postId, user_id: userId }).save();
      await CommunityPost.findByIdAndUpdate(postId, { $inc: { likes_count: 1 } });
      res.json({ liked: true });
    }
  } catch (error) {
    console.error('Toggle like error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// GET /api/community/posts/:id/comments - Get comments for a post
router.get('/posts/:id/comments', auth, async (req, res) => {
  try {
    const comments = await CommunityComment.find({ post_id: req.params.id })
      .sort({ created_at: -1 })
      .populate('user_id', 'full_name avatar_url');

    const formatted = comments.map(c => ({
      id: c._id.toString(),
      authorId: c.user_id?._id?.toString() || '',
      authorName: c.user_id?.full_name || 'Unknown',
      authorAvatar: c.user_id?.avatar_url || 'https://i.pravatar.cc/150?img=1',
      content: c.content,
      date: c.created_at.toLocaleDateString('vi-VN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      likes: c.likes || 0
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

// POST /api/community/posts/:id/comments - Add comment to a post
router.post('/posts/:id/comments', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Nội dung bình luận là bắt buộc.' });
    }

    const comment = new CommunityComment({
      post_id: req.params.id,
      user_id: req.user.userId,
      content
    });
    await comment.save();

    // Increment comments count
    await CommunityPost.findByIdAndUpdate(req.params.id, { $inc: { comments_count: 1 } });

    const user = await User.findById(req.user.userId).select('full_name avatar_url');

    res.status(201).json({
      id: comment._id.toString(),
      authorId: req.user.userId,
      authorName: user?.full_name || 'Unknown',
      authorAvatar: user?.avatar_url || 'https://i.pravatar.cc/150?img=1',
      content: comment.content,
      date: 'VỪA XONG',
      likes: 0
    });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống.' });
  }
});

module.exports = router;
